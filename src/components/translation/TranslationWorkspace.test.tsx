/**
 * Controller lifetime regression suite.
 *
 * The defect this guards against: the workspace rebuilt its translation
 * controller on every render, because the controller closed over the
 * connection store, which is a new object each render. A new controller has an
 * empty "unchanged input" guard, no IME composition flag and its own
 * latest-wins slot. So each re-render after a success scheduled another
 * request for the same text, older requests were never aborted, and the
 * requests multiplied without bound (about 1000 in under a second, seen in a
 * real diagnostic log while typing pinyin).
 *
 * The same store identity churn re-ran the "restore from URL" effect on every
 * render. That effect and the "mirror into URL" effect then swapped the old and
 * new text forever: an infinite render loop from the second typed character.
 *
 * @vitest-environment jsdom
 */

import { vi } from "vitest";

vi.mock("@tanstack/react-router", async () => {
	const actual = await vi.importActual<typeof import("@tanstack/react-router")>(
		"@tanstack/react-router",
	);
	return {
		...actual,
		Link: ({
			to,
			children,
			...rest
		}: {
			to: string;
			children: React.ReactNode;
		}) => (
			<a href={to} {...rest}>
				{children}
			</a>
		),
	};
});

const created = vi.hoisted(() => ({ count: 0 }));

vi.mock("#/lib/translation/controller", async () => {
	const actual = await vi.importActual<
		typeof import("#/lib/translation/controller")
	>("#/lib/translation/controller");
	return {
		...actual,
		createTranslationController: (
			...args: Parameters<typeof actual.createTranslationController>
		) => {
			created.count += 1;
			return actual.createTranslationController(...args);
		},
	};
});

import { act, Profiler } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TranslationWorkspace } from "#/components/translation/TranslationWorkspace";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

/** Type into a React-controlled textarea the way the browser does. */
function typeInto(textarea: HTMLTextAreaElement, value: string): void {
	const setter = Object.getOwnPropertyDescriptor(
		HTMLTextAreaElement.prototype,
		"value",
	)?.set;
	setter?.call(textarea, value);
	textarea.dispatchEvent(new Event("input", { bubbles: true }));
}

/**
 * Commit budget for the whole scenario. A render loop exceeds it at once; the
 * throw turns a hang into a failure.
 */
const MAX_COMMITS = 200;
let commits = 0;
function countCommit(): void {
	commits += 1;
	if (commits > MAX_COMMITS) {
		throw new Error(`render loop: more than ${MAX_COMMITS} commits`);
	}
}

describe("TranslationWorkspace render stability", () => {
	let container: HTMLDivElement;

	beforeEach(() => {
		created.count = 0;
		commits = 0;
		window.history.replaceState(null, "", "/");
		container = document.createElement("div");
		document.body.append(container);
	});

	afterEach(() => {
		container.remove();
	});

	it("keeps one controller and settles after each keystroke", async () => {
		const root = createRoot(container);
		await act(async () => {
			root.render(
				<Profiler id="workspace" onRender={countCommit}>
					<TranslationWorkspace />
				</Profiler>,
			);
		});
		const afterMount = created.count;

		const textarea = container.querySelector("textarea");
		expect(textarea).not.toBeNull();
		if (textarea === null) return;

		// Every keystroke re-renders the workspace, as does every success.
		for (const value of ["n", "ni", "你", "你好"]) {
			await act(async () => {
				typeInto(textarea, value);
			});
		}

		expect(created.count).toBe(afterMount);
		expect(textarea.value).toBe("你好");
		expect(new URLSearchParams(window.location.search).get("text")).toBe(
			"你好",
		);
		expect(commits).toBeLessThanOrEqual(MAX_COMMITS);
		await act(async () => {
			root.unmount();
		});
	});
});
