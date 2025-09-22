import {WorkerTask} from "./featurefilter.worker";

export type JobGroupType = 'search' | 'completion' | 'diagnostics';

export class JobGroup {
    readonly id: string;
    readonly type: JobGroupType;
    readonly query: string;

    private tasks: Map<string, WorkerTask> = new Map();
    private completedTasks: Set<string> = new Set();
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
    }

    completeTask(taskId: string, result?: any): void {
        if (this.tasks.has(taskId) && !this.completedTasks.has(taskId)) {
            this.completedTasks.add(taskId);
            
            if (this.onTaskCompleteCallback) {
                this.onTaskCompleteCallback(taskId, result);
            }
            
            if (this.isComplete() && this.onCompleteCallback) {
                this.onCompleteCallback(this);
            }
        }
    }

    isComplete(): boolean {
        return this.tasks.size > 0 && this.completedTasks.size === this.tasks.size;
    }

    getProgress(): number {
        if (this.tasks.size === 0) return 0;
        return (this.completedTasks.size / this.tasks.size) * 100;
    }

    getTaskCount(): number {
        return this.tasks.size;
    }

    getCompletedCount(): number {
        return this.completedTasks.size;
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

    getCompletedTasks(): ReadonlySet<string> {
        return this.completedTasks;
    }

    cancel(): void {
        this.tasks.clear();
        this.completedTasks.clear();
        this.onCompleteCallback = undefined;
        this.onTaskCompleteCallback = undefined;
        this.diagnostics.length = 0;
    }

    addDiagnostics(diagnostics: Uint8Array): void {
        this.diagnostics.push(diagnostics);
    }

    getDiagnostics(): ReadonlyArray<Uint8Array> {
        return this.diagnostics;
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

    getGroup(groupId: string): JobGroup | undefined {
        return this.groups.get(groupId);
    }

    addTaskToGroup(groupId: string, taskId: string, task: WorkerTask): boolean {
        const group = this.groups.get(groupId);
        if (group) {
            group.addTask(taskId, task);
            this.taskToGroup.set(taskId, groupId);
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
            group.cancel();
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
