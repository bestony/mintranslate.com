import type { DocumentTaskRecord } from "#/lib/document/model";

/** Whether the current controller permits another document run to start. */
export function canStartDocumentRun(
	controller: AbortController | undefined,
): boolean {
	return controller === undefined || controller.signal.aborted;
}

/** Whether resume controls must be disabled while this session is running work. */
export function shouldDisableResume(activeTask: boolean): boolean {
	return activeTask;
}

/** Whether a task is the run currently owned by this component instance. */
export function isActiveDocumentRun(
	entry: DocumentTaskRecord,
	activeTaskId: string | undefined,
	activeTask: boolean,
): boolean {
	return activeTask && entry.id === activeTaskId;
}

/** Whether deleting a task is safe for this session. */
export function canDeleteDocumentTask(
	entry: DocumentTaskRecord,
	activeTaskId: string | undefined,
	activeTask: boolean,
): boolean {
	return !isActiveDocumentRun(entry, activeTaskId, activeTask);
}
