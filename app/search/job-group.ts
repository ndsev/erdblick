import {WorkerTask} from "./search.worker";

/**
 * Distinguishes the worker pipelines that share the same scheduling machinery.
 */
export type JobGroupType = 'search' | 'completion' | 'diagnostics';

/**
 * Tracks one logical batch of worker tasks.
 *
 * A job group owns the FIFO queue, in-progress bookkeeping, completion callbacks,
 * and any binary diagnostics payloads that need to survive until the search UI aggregates them.
 */
export class JobGroup {
    readonly id: string;
    readonly type: JobGroupType;
    readonly query: string;

    private tasks: Map<string, WorkerTask> = new Map();
    private pending: WorkerTask[] = [];
    private inProgress: Set<string> = new Set<string>();
    private completed: Set<string> = new Set<string>();

    private onCompleteCallback?: (group: JobGroup) => void;
    private onTaskCompleteCallback?: (taskId: string, result: any) => void;
    
    // Runtime/result data
    private diagnostics: Array<Uint8Array> = [];

    /**
     * Creates a new logical task batch for the given query string.
     */
    constructor(type: JobGroupType, query: string, id: string) {
        this.id = id;
        this.type = type;
        this.query = query;
    }

    /**
     * Registers a task with the group and appends it to the dispatch queue.
     */
    addTask(taskId: string, task: WorkerTask): void {
        this.tasks.set(taskId, task);
        this.pending.push(task);
    }

    /**
     * Marks a task complete, forwards its result to listeners, and closes the group if nothing remains.
     */
    completeTask(taskId: string, result?: any): void {
        if (!this.tasks.has(taskId)) {
            return;
        }

        this.inProgress.delete(taskId);
        this.completed.add(taskId);

        console.log(`Task complete: ${taskId}`)
        if (this.onTaskCompleteCallback) {
            this.onTaskCompleteCallback(taskId, result);
        }

        if (this.isComplete() && this.onCompleteCallback) {
            console.log(`Group complete: ${this.id}`)
            this.onCompleteCallback(this);
        }
    }

    /**
     * Returns true once the queue is empty and no worker is still running a task from this group.
     */
    isComplete(): boolean {
        return !this.pending.length && !this.inProgress.size;
    }

    /**
     * Returns the total number of tasks that were ever registered with this group.
     */
    getTaskCount(): number {
        return this.tasks.size;
    }

    /**
     * Returns how many registered tasks finished successfully or with an error result.
     */
    getCompletedCount(): number {
        return this.completed.size;
    }

    /**
     * Expresses completion as a percentage for progress-bar style UI.
     */
    percentDone(): number {
        return this.getTaskCount() ? this.getCompletedCount() / this.getTaskCount() * 100. : 0.;
    }

    /**
     * Installs a completion callback and fires it immediately if the group has already finished.
     */
    onComplete(callback: (group: JobGroup) => void): void {
        this.onCompleteCallback = callback;
        
        // If already complete, call immediately
        if (this.isComplete()) {
            callback(this);
        }
    }

    /**
     * Installs a callback that receives each worker result as the group drains.
     */
    onTaskComplete(callback: (taskId: string, result: any) => void): void {
        this.onTaskCompleteCallback = callback;
    }

    /**
     * Exposes the registered task map for diagnostics and teardown logic.
     */
    getTasks(): ReadonlyMap<string, WorkerTask> {
        return this.tasks;
    }

    /**
     * Drops task bookkeeping and callbacks so the group can be forgotten safely.
     */
    clear(): void {
        this.tasks.clear();
        this.completed.clear();
        this.onCompleteCallback = undefined;
        this.onTaskCompleteCallback = undefined;
        this.diagnostics.length = 0;
    }

    /**
     * Cancels any queued work while leaving already running tasks to finish naturally.
     */
    stop() {
        if (this.pending.length) {
            this.pending = [];
            if (this.isComplete() && this.onCompleteCallback) {
                console.log(`Group complete (canceled): ${this.id}`)
                this.onCompleteCallback(this);
            }
        }
    }

    /**
     * Stores a serialized diagnostics blob emitted by a worker.
     */
    addDiagnostics(diagnostics: Uint8Array): void {
        this.diagnostics.push(diagnostics);
    }

    /**
     * Returns all collected diagnostics payloads for later aggregation.
     */
    getDiagnostics(): ReadonlyArray<Uint8Array> {
        return this.diagnostics;
    }

    /**
     * Pops the next queued task and marks it as running.
     */
    takeTask(): WorkerTask|undefined {
        const result = this.pending.shift();
        if (result) {
            this.inProgress.add(result.taskId);
        }
        return result;
    }
}

/**
 * Keeps the active job groups and the reverse task-to-group lookup in sync.
 *
 * Search and completion share this manager so worker callbacks can resolve a task
 * back to its logical batch without threading extra state through every caller.
 */
export class JobGroupManager {
    private groups: Map<string, JobGroup> = new Map();
    private taskToGroup: Map<string, string> = new Map();

    /**
     * Creates and registers a new group in one step.
     */
    createGroup(type: JobGroupType, query: string, id: string): JobGroup {
        const group = new JobGroup(type, query, id);
        this.groups.set(group.id, group);
        return group;
    }

    /**
     * Registers an existing group, typically a specialized subclass such as SearchState.
     */
    addGroup(group: JobGroup) {
        this.groups.set(group.id, group)
    }

    /**
     * Looks up a group by id without creating it implicitly.
     */
    getGroup(groupId: string): JobGroup | undefined {
        return this.groups.get(groupId);
    }

    /**
     * Adds a task to its owning group and records the reverse lookup for worker callbacks.
     */
    addTask(task: WorkerTask): boolean {
        const group = this.groups.get(task.groupId);
        if (group) {
            group.addTask(task.taskId, task);
            this.taskToGroup.set(task.taskId, task.groupId);
            return true;
        }
        return false;
    }

    /**
     * Forwards a worker result to the owning group if the task is still known.
     */
    completeTask(taskId: string, result?: any): boolean {
        const groupId = this.taskToGroup.get(taskId);
        if (groupId) {
            const group = this.groups.get(groupId);
            if (group) {
                group.completeTask(taskId, result);
                return true;
            }
        }
        return false;
    }

    /**
     * Resolves a task id back to the group that scheduled it.
     */
    getGroupForTask(taskId: string): JobGroup | undefined {
        const groupId = this.taskToGroup.get(taskId);
        return groupId ? this.groups.get(groupId) : undefined;
    }

    /**
     * Removes a group and tears down all reverse task mappings that point to it.
     */
    removeGroup(groupId: string): void {
        const group = this.groups.get(groupId);
        if (group) {
            // Clean up task mappings
            for (const taskId of group.getTasks().keys()) {
                this.taskToGroup.delete(taskId);
            }
            group.clear();
            this.groups.delete(groupId);
        }
    }

    /**
     * Returns groups that still have pending or in-progress work.
     */
    getActiveGroups(): JobGroup[] {
        return Array.from(this.groups.values()).filter(group => !group.isComplete());
    }

    /**
     * Returns groups whose queues and running-task sets are empty.
     */
    getCompletedGroups(): JobGroup[] {
        return Array.from(this.groups.values()).filter(group => group.isComplete());
    }

    /**
     * Removes all completed groups and their task mappings in one pass.
     */
    clearCompleted(): void {
        const completed = this.getCompletedGroups();
        for (const group of completed) {
            this.removeGroup(group.id);
        }
    }

    /**
     * Summarizes group and task counts for diagnostics UIs.
     */
    getStats(): {
        activeGroups: number;
        completedGroups: number;
        totalTasks: number;
        completedTasks: number;
    } {
        const active = this.getActiveGroups();
        const completed = this.getCompletedGroups();
        
        const totalTasks = Array.from(this.groups.values())
            .reduce((sum, group) => sum + group.getTaskCount(), 0);
        const completedTasks = Array.from(this.groups.values())
            .reduce((sum, group) => sum + group.getCompletedCount(), 0);

        return {
            activeGroups: active.length,
            completedGroups: completed.length,
            totalTasks,
            completedTasks
        };
    }

    // Convenience methods for search groups
    /**
     * Returns the currently active search group, if any.
     */
    getCurrentSearchGroup(): JobGroup | undefined {
        return Array.from(this.groups.values())
            .find(group => group.type === 'search' && !group.isComplete());
    }

    /**
     * Returns raw diagnostics only for search groups, since completion groups never collect them.
     */
    getSearchGroupDiagnostics(groupId: string): ReadonlyArray<Uint8Array> | undefined {
        const group = this.groups.get(groupId);
        return group?.type === 'search' ? group.getDiagnostics() : undefined;
    }
}
