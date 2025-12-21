export const en = {
	common: {
		actions: {
			add: "Add",
			cancel: "Cancel",
			clear: "Clear",
			close: "Close",
			delete: "Delete",
			edit: "Edit",
			save: "Save",
			saving: "Saving…",
			setDefault: "Set default",
		},
		languages: {
			en: "English",
			es: "Spanish",
			fr: "French",
			ja: "Japanese",
			zh: "Chinese",
		},
		shortcuts: {
			label: "Shortcut:",
		},
		status: {
			default: "Default",
			loading: "Loading…",
			translating: "Translating",
			validating: "Validating…",
		},
		toasts: {
			copied: "Copied to clipboard",
			copyFailed: "Copy failed. Please copy manually.",
		},
		units: {
			characters: "{{count}} characters",
		},
	},
	errors: {
		aiRequestFailed: "AI request failed",
		anthropicApiKeyMissing: "Anthropic API key is not configured",
		apiKeyRequired: "Please enter an API key",
		geminiApiKeyMissing: "Gemini API key is not configured",
		modelRequired: "Please enter a model",
		openaiApiKeyMissing: "OpenAI API key is not configured",
		providerNameRequired: "Please enter a provider name",
		translationCanceled: "Translation canceled",
		translationFailed: "Translation failed",
	},
	nav: {
		docs: "Docs",
		language: "Language",
	},
	footer: {
		links: {
			github: "GitHub Repo",
			docs: "Docs",
			feedback: "Feedback",
			community: "Community",
		},
	},
	notFound: {
		title: "Page not found",
		description: "The page you’re looking for doesn’t exist or has moved.",
		actions: {
			goHome: "Go to home",
			openDocs: "Open docs",
		},
	},
	settingsPage: {
		title: "Settings",
		subtitle:
			"Manage system prompt and AI providers. All settings are saved locally in your browser.",
		actions: {
			backHome: "Back home",
		},
		systemPrompt: {
			title: "System prompt",
			description:
				"Used as the system instruction for each translation request (saved to localStorage).",
			fields: {
				systemPrompt: {
					label: "System prompt",
					placeholder: "Enter a system prompt…",
				},
			},
			actions: {
				reset: "Reset to default",
			},
			toasts: {
				saved: "System prompt saved",
				saveFailed: "Failed to save system prompt",
			},
		},
		providers: {
			title: "AI providers",
			description:
				"Configure OpenAI / Anthropic / Gemini / Ollama (localStorage).",
		},
	},
	home: {
		alerts: {
			providerRequired: {
				description:
					"Please set up a default provider (API Key / Ollama host) before translating.",
				title: "Provider required",
			},
			translateFailed: {
				title: "Translation failed",
			},
		},
		features: {
			localHistory: {
				description:
					"Translation history is saved in your browser for easy viewing and copying.",
				title: "Local history",
			},
			multiProvider: {
				description: "Choose OpenAI / Anthropic / Gemini / Ollama as needed.",
				title: "Multiple providers",
			},
			shortcuts: {
				prefix: "Use",
				suffix: "to translate quickly.",
				title: "Shortcuts",
			},
		},
		history: {
			actions: {
				clear: "Clear history",
				viewAll: "View all",
			},
			caption: {
				last3: "Last 3",
				total: "{{count}} items",
			},
			confirm: {
				description:
					"This will delete all saved translation history in your browser.",
				title: "Clear translation history?",
			},
			description:
				"Successful translations are automatically saved to your browser (IndexedDB).",
			empty: "No records yet.",
			title: "Translation history",
			toasts: {
				cleared: "Translation history cleared",
			},
		},
		providerDialog: {
			configured: {
				empty: "No providers yet.",
				title: "Configured providers",
			},
			confirmDelete: {
				description:
					"This will delete “{{name}}”. This only affects your local browser settings.",
				title: "Delete provider?",
			},
			description:
				"Provider settings are saved locally in your browser (localStorage) and used to make requests to the selected AI service.",
			form: {
				titleEdit: "Edit provider",
				titleNew: "New provider",
				fields: {
					apiKey: {
						label: "API Key",
						placeholder: "Enter your API key",
					},
					baseUrl: {
						label: "Base URL (optional)",
						placeholder:
							"Leave blank to use default: https://api.openai.com/v1",
					},
					model: {
						label: "Model",
						placeholder:
							"e.g. gpt-4.1-mini / claude-3-5-haiku / gemini-2.5-flash / llama3",
					},
					name: {
						label: "Name",
						placeholder: "e.g. My OpenAI / My Gemini",
					},
					ollamaHost: {
						label: "Ollama Host (optional)",
						placeholder: "Leave blank to use default: http://localhost:11434",
					},
					providerType: {
						label: "Provider",
						placeholder: "Select a provider type",
					},
				},
				submitErrorTitle: "Save failed",
				toasts: {
					saved: "Provider saved",
				},
			},
			title: "Configure AI providers",
			toasts: {
				deleted: "Deleted “{{name}}”",
				setDefault: "Set as default: {{name}}",
			},
		},
		subtitle:
			"A minimal AI translator supporting OpenAI / Anthropic / Gemini / Ollama.",
		translator: {
			source: {
				clear: "Clear",
				description: "Enter text in {{language}}",
				placeholder: "Enter the text you want to translate…",
				swapLanguages: "Swap languages",
				title: "Source",
				translateNow: "Translate now",
			},
			target: {
				copyTranslation: "Copy translation",
				description: "{{source}} → {{target}}",
				placeholder: "Translation will appear here…",
				title: "Translation",
			},
		},
		ui: {
			badges: {
				noProvider: "No provider configured",
			},
			buttons: {
				editModelSettings: "Edit Model Settings",
				manageProvider: "Settings",
				provider: "Provider",
				setupProvider: "Quick Start",
			},
			tooltips: {
				copySource: "Copy source",
				copyTranslation: "Copy translation",
			},
		},
	},
	translateHistoryPage: {
		title: "Translation history",
		subtitle: "Browse, export, and manage your local translation history.",
		actions: {
			backHome: "Back home",
			clear: "Clear history",
			exportJson: "Export JSON",
			pageSize: "Items per page",
		},
		pageSize: {
			items10: "10 / page",
			items100: "100 / page",
		},
		card: {
			title: "All records",
			description: "Saved locally in your browser (IndexedDB).",
			total: "{{count}} items",
		},
		confirm: {
			title: "Clear translation history?",
			description:
				"This will delete all saved translation history in your browser.",
		},
		empty: "No records yet.",
		pagination: {
			next: "Next",
			page: "Page {{page}} / {{pageCount}}",
			prev: "Previous",
			showing: "Showing {{from}}–{{to}} of {{total}}",
		},
		toasts: {
			cleared: "Translation history cleared",
			exportFailed: "Export failed",
			exported: "Exported JSON",
		},
	},
} as const;
