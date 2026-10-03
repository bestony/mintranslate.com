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
