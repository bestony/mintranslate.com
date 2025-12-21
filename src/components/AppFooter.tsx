import { Link, useParams } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";

import { normalizeAppLanguage } from "@/lib/app-i18n";
import { DEFAULT_DOCS_LANGUAGE } from "@/lib/docs-language";
import { cn } from "@/lib/utils";

const GITHUB_REPO_URL = "https://github.com/bestony/mintranslate.com" as const;
const FEEDBACK_URL = `${GITHUB_REPO_URL}/issues/new` as const;
const COMMUNITY_URL =
	"https://github.com/bestony/mintranslate.com/discussions" as const;

export function AppFooter({ className }: { className?: string }) {
	const { t, i18n } = useTranslation();
	const { lang } = useParams({ strict: false });

	const docsLang =
		normalizeAppLanguage(lang ?? i18n.resolvedLanguage) ??
		DEFAULT_DOCS_LANGUAGE;

	const linkClassName =
		"text-muted-foreground underline underline-offset-4 hover:text-primary";

	return (
		<footer
			className={cn("border-t bg-background/40 backdrop-blur", className)}
		>
			<div className="mx-auto container px-4 py-6 sm:px-6 lg:px-10">
				<nav
					aria-label="Footer"
					className="flex flex-wrap items-center justify-center gap-x-6 gap-y-2 text-sm"
				>
					<a
						href={GITHUB_REPO_URL}
						target="_blank"
						rel="noopener noreferrer"
						className={linkClassName}
					>
						{t("footer.links.github")}
					</a>
					<Link
						to="/$lang/docs/$"
						params={{ lang: docsLang, _splat: "" }}
						className={linkClassName}
					>
						{t("footer.links.docs")}
					</Link>
					<a
						href={FEEDBACK_URL}
						target="_blank"
						rel="noopener noreferrer"
						className={linkClassName}
					>
						{t("footer.links.feedback")}
					</a>
					<a
						href={COMMUNITY_URL}
						target="_blank"
						rel="noopener noreferrer"
						className={linkClassName}
					>
						{t("footer.links.community")}
					</a>
				</nav>
			</div>
		</footer>
	);
}
