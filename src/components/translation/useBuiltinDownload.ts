import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
	activateBuiltinDownload,
	type BuiltinDownloadState,
	downloadRequestFromError,
	INITIAL_BUILTIN_DOWNLOAD_STATE,
	reduceBuiltinDownload,
} from "#/lib/builtin-ai/download";
import type { BuiltinLanguageModelClient } from "#/lib/builtin-ai/language-model";
import type { BuiltinTranslatorClient } from "#/lib/builtin-ai/translator";
import { createLatestCall } from "#/lib/call-control/latest-call";
import { logger } from "#/lib/logger";

/** One pending intent; cancellation and stale results use the existing primitive. */
export function useBuiltinDownload(options: {
	readonly intentKey: string;
	readonly translator?: BuiltinTranslatorClient;
	readonly languageModel?: BuiltinLanguageModelClient;
}) {
	const { intentKey: requestKey, translator, languageModel } = options;
	const [state, setState] = useState<BuiltinDownloadState>(
		INITIAL_BUILTIN_DOWNLOAD_STATE,
	);
	const latest = useMemo(() => createLatestCall(), []);
	const intentKey = useRef(requestKey);
	const previousIntentKey = useRef(requestKey);
	intentKey.current = requestKey;
	const pending = useRef<
		| {
				key: string;
				state: BuiltinDownloadState;
				continueTranslation: () => void;
		  }
		| undefined
	>(undefined);

	const reset = useCallback(() => {
		latest.cancel();
		pending.current = undefined;
		setState(INITIAL_BUILTIN_DOWNLOAD_STATE);
	}, [latest]);

	useEffect(() => {
		if (previousIntentKey.current === requestKey) return;
		previousIntentKey.current = requestKey;
		latest.cancel();
		pending.current = undefined;
		setState(INITIAL_BUILTIN_DOWNLOAD_STATE);
	}, [latest, requestKey]);
	useEffect(
		() => () => {
			latest.cancel();
			pending.current = undefined;
		},
		[latest],
	);

	const offer = useCallback(
		(error: unknown, key: string, continueTranslation: () => void): boolean => {
			const request = downloadRequestFromError(error);
			if (request === undefined) return false;
			if (key !== intentKey.current) return true;
			latest.cancel();
			const next = reduceBuiltinDownload(INITIAL_BUILTIN_DOWNLOAD_STATE, {
				type: "required",
				request,
			});
			pending.current = { key, state: next, continueTranslation };
			setState(next);
			logger.debug("builtin.download.required", { provider: request.provider });
			return true;
		},
		[latest],
	);

	const activate = useCallback(async () => {
		const intent = pending.current;
		const request = intent?.state.request;
		if (
			intent === undefined ||
			request === undefined ||
			latest.busy() ||
			intent.key !== intentKey.current
		)
			return;
		setState(reduceBuiltinDownload(intent.state, { type: "start" }));
		logger.info("builtin.download.start", { provider: request.provider });
		try {
			const outcome = await latest.run((signal) =>
				activateBuiltinDownload(
					request,
					{ translator, languageModel },
					(value) => {
						if (!signal.aborted && intent.key === intentKey.current)
							setState((current) =>
								reduceBuiltinDownload(current, { type: "progress", value }),
							);
					},
					signal,
				),
			);
			if (
				outcome.kind === "superseded" ||
				intent.key !== intentKey.current ||
				pending.current !== intent
			)
				return;
			pending.current = undefined;
			setState(INITIAL_BUILTIN_DOWNLOAD_STATE);
			logger.info("builtin.download.complete", { provider: request.provider });
			intent.continueTranslation();
		} catch {
			if (intent.key !== intentKey.current || pending.current !== intent)
				return;
			setState((current) =>
				reduceBuiltinDownload(current, {
					type: "failed",
					message: "模型下载失败，请重试。",
				}),
			);
			logger.warn("builtin.download.failed", { provider: request.provider });
		}
	}, [latest, translator, languageModel]);

	return { state, offer, activate, reset };
}
