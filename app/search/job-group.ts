import {WorkerTask} from "./search.worker";

export type JobGroupType = 'search' | 'completion' | 'diagnostics';

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

    constructor(type: JobGroupType, query: string, id: string) {
        this.id = id;
        this.type = type;
        this.query = query;
    }

    addTask(taskId: string, task: WorkerTask): void {
        this.tasks.set(taskId, task);
        this.pending.push(task);
    }

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

    isComplete(): boolean {
        return !this.pending.length && !this.inProgress.size;
    }

    getTaskCount(): number {
        return this.tasks.size;
    }

    getCompletedCount(): number {
        return this.completed.size;
    }

    percentDone(): number {
        return this.getTaskCount() ? this.getCompletedCount() / this.getTaskCount() * 100. : 0.;
    }

    onComplete(callback: (group: JobGroup) => void): void {
        this.onCompleteCallback = callback;
        
        // If already complete, call immediately
        if (this.isComplete()) {
            callback(this);
        }
    }

    onTaskComplete(callback: (taskId: string, result: any) => void): void {
        this.onTaskCompleteCallback = callback;
    }

    getTasks(): ReadonlyMap<string, WorkerTask> {
        return this.tasks;
    }

    clear(): void {
        this.tasks.clear();
        this.completed.clear();
        this.onCompleteCallback = undefined;
        this.onTaskCompleteCallback = undefined;
        this.diagnostics.length = 0;
    }

    cancel() {
        if (this.pending.length) {
            this.pending = [];
            if (this.isComplete() && this.onCompleteCallback) {
                console.log(`Group complete (canceled): ${this.id}`)
                this.onCompleteCallback(this);
            }
        }
    }

    addDiagnostics(diagnostics: Uint8Array): void {
        this.diagnostics.push(diagnostics);
    }

    getDiagnostics(): ReadonlyArray<Uint8Array> {
        return this.diagnostics;
    }

    takeTask(): WorkerTask|undefined {
        const result = this.pending.shift();
        if (result) {
            this.inProgress.add(result.taskId);
        }
        return result;
    }
}

export class JobGroupManager {
    private groups: Map<string, JobGroup> = new Map();
    private taskToGroup: Map<string, string> = new Map();

    createGroup(type: JobGroupType, query: string, id: string): JobGroup {
        const group = new JobGroup(type, query, id);
        this.groups.set(group.id, group);
        return group;
    }

    addGroup(group: JobGroup) {
        this.groups.set(group.id, group)
    }

    getGroup(groupId: string): JobGroup | undefined {
        return this.groups.get(groupId);
    }

    addTask(task: WorkerTask): boolean {
        const group = this.groups.get(task.groupId);
        if (group) {
            group.addTask(task.taskId, task);
            this.taskToGroup.set(task.taskId, task.groupId);
            return true;
        }
        return false;
    }

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

    getGroupForTask(taskId: string): JobGroup | undefined {
        const groupId = this.taskToGroup.get(taskId);
        return groupId ? this.groups.get(groupId) : undefined;
    }

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

    getActiveGroups(): JobGroup[] {
        return Array.from(this.groups.values()).filter(group => !group.isComplete());
    }

    getCompletedGroups(): JobGroup[] {
        return Array.from(this.groups.values()).filter(group => group.isComplete());
    }

    clearCompleted(): void {
        const completed = this.getCompletedGroups();
        for (const group of completed) {
            this.removeGroup(group.id);
        }
    }

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
    getCurrentSearchGroup(): JobGroup | undefined {
        return Array.from(this.groups.values())
            .find(group => group.type === 'search' && !group.isComplete());
    }

    getSearchGroupDiagnostics(groupId: string): ReadonlyArray<Uint8Array> | undefined {
        const group = this.groups.get(groupId);
        return group?.type === 'search' ? group.getDiagnostics() : undefined;
    }
}
