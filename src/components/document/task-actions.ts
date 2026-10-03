import type { DocumentTaskRecord } from "#/lib/document/model";

/** The component-owned reservation for one document run. */
export interface DocumentRunReservation {
	readonly controller: AbortController;
	readonly taskId?: string;
}

/** Reserve the run slot, without consulting task state or controller status. */
export function reserveDocumentRun(
	current: DocumentRunReservation | undefined,
	controller: AbortController,
	taskId?: string,
): DocumentRunReservation | undefined {
	if (current !== undefined) return undefined;
	return {
		controller,
		...(taskId !== undefined && { taskId }),
	};
}

/** Bind the task id after a newly uploaded document has been parsed. */
export function bindDocumentRunTask(
	reservation: DocumentRunReservation,
	taskId: string,
): DocumentRunReservation {
	return { ...reservation, taskId };
}

/** Whether another document run may reserve the component. */
export function canStartDocumentRun(
	reservation: DocumentRunReservation | undefined,
): boolean {
	return reservation === undefined;
}

/** Whether a callback still owns the reservation it was given. */
export function ownsDocumentRun(
	current: DocumentRunReservation | undefined,
	candidate: DocumentRunReservation,
): boolean {
	return current === candidate;
}

/** Whether controls that start another run must be disabled. */
export function shouldDisableResume(
	reservation: DocumentRunReservation | undefined,
): boolean {
	return reservation !== undefined;
}

/** Whether a non-terminal task has a local source file that can be resumed. */
export function hasResumableSource(
	entry: DocumentTaskRecord,
	sourceAvailable: boolean,
): boolean {
	return entry.state !== "succeeded" && sourceAvailable;
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

/** Whether deletion must be disabled while the task is being set up or run. */
export function shouldDisableDeleteDocumentTask(
	entry: DocumentTaskRecord,
	reservation: DocumentRunReservation | undefined,
): boolean {
	return reservation?.taskId === entry.id;
}
