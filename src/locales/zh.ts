export const zh = {
	common: {
		actions: {
			add: "新增",
			cancel: "取消",
			clear: "清空",
			close: "关闭",
			delete: "删除",
			edit: "编辑",
			save: "保存",
			saving: "保存中…",
			setDefault: "设为默认",
		},
		languages: {
			en: "英文",
			es: "西班牙语",
			fr: "法语",
			ja: "日语",
			zh: "中文",
		},
		shortcuts: {
			label: "快捷键：",
		},
		status: {
			default: "默认",
			loading: "加载中…",
			translating: "翻译中",
			validating: "验证中…",
		},
		toasts: {
			copied: "已复制到剪贴板",
			copyFailed: "复制失败，请手动选择复制",
		},
		units: {
			characters: "{{count}} 字符",
		},
	},
	errors: {
		aiRequestFailed: "AI 请求失败",
		anthropicApiKeyMissing: "Anthropic API Key 未配置",
		apiKeyRequired: "请输入 API Key",
		geminiApiKeyMissing: "Gemini API Key 未配置",
		modelRequired: "请输入 Model",
		openaiApiKeyMissing: "OpenAI API Key 未配置",
		providerNameRequired: "请输入 Provider 名称",
		translationCanceled: "已取消翻译",
		translationFailed: "翻译失败",
	},
	nav: {
		docs: "文档",
		language: "语言",
	},
	footer: {
		links: {
			github: "GitHub Repo",
			docs: "文档",
			feedback: "Feedback",
			community: "Community",
		},
	},
	notFound: {
		title: "页面未找到",
		description: "你访问的页面不存在或已被移动。",
		actions: {
			goHome: "返回首页",
			openDocs: "打开文档",
		},
	},
	settingsPage: {
		title: "设置",
		subtitle:
			"管理 system prompt 与 AI Providers，所有配置将保存在本地浏览器。",
		actions: {
			backHome: "返回首页",
		},
		systemPrompt: {
			title: "System prompt",
			description: "作为每次翻译请求的系统指令（保存于 localStorage）。",
			fields: {
				systemPrompt: {
					label: "System prompt",
					placeholder: "请输入 system prompt…",
				},
			},
			actions: {
				reset: "恢复默认",
			},
			toasts: {
				saved: "System prompt 已保存",
				saveFailed: "保存 system prompt 失败",
			},
		},
		providers: {
			title: "AI Providers",
			description:
				"配置 OpenAI / Anthropic / Gemini / Ollama（localStorage）。",
		},
	},
	home: {
		alerts: {
			providerRequired: {
				description:
					"请先配置默认 Provider（API Key / Ollama Host），再开始翻译。",
				title: "需要配置 Provider",
			},
			translateFailed: {
				title: "翻译失败",
			},
		},
		features: {
			localHistory: {
				description: "翻译记录保存在本地浏览器，随时查看与复制。",
				title: "本地历史",
			},
			multiProvider: {
				description: "OpenAI / Anthropic / Gemini / Ollama，按需选择模型。",
				title: "多 Provider",
			},
			shortcuts: {
				prefix: "使用",
				suffix: "快速翻译。",
				title: "快捷键",
			},
		},
		history: {
			actions: {
				clear: "清空历史",
				viewAll: "查看全部",
			},
			caption: {
				last3: "最近 3 条",
				total: "{{count}} 条",
			},
			confirm: {
				description: "将删除本地浏览器中保存的全部翻译历史记录。",
				title: "清空翻译历史？",
			},
			description: "成功翻译后会自动写入本地浏览器（IndexedDB）。",
			empty: "暂无记录。",
			title: "翻译历史",
			toasts: {
				cleared: "已清空翻译历史",
			},
		},
		providerDialog: {
			configured: {
				empty: "暂无配置。",
				title: "已配置 Providers",
			},
			confirmDelete: {
				description: "将删除「{{name}}」。该操作只影响本地浏览器中的配置。",
				title: "删除 Provider？",
			},
			description:
				"Provider 配置会保存在本地浏览器（localStorage），用于向对应的 AI 服务发起请求。",
			form: {
				titleEdit: "编辑 Provider",
				titleNew: "新增 Provider",
				fields: {
					apiKey: {
						label: "API Key",
						placeholder: "请输入你的 API Key",
					},
					baseUrl: {
						label: "Base URL（可选）",
						placeholder: "留空使用默认：https://api.openai.com/v1",
					},
					model: {
						label: "Model",
						placeholder:
							"例如：gpt-4.1-mini / claude-3-5-haiku / gemini-2.5-flash / llama3",
					},
					name: {
						label: "名称",
						placeholder: "例如：我的 OpenAI / 我的 Gemini",
					},
					ollamaHost: {
						label: "Ollama Host（可选）",
						placeholder: "留空使用默认：http://localhost:11434",
					},
					providerType: {
						label: "Provider",
						placeholder: "请选择 Provider 类型",
					},
				},
				submitErrorTitle: "保存失败",
				toasts: {
					saved: "Provider 已保存",
				},
			},
			title: "配置 AI Providers",
			toasts: {
				deleted: "已删除「{{name}}」",
				setDefault: "已设为默认：{{name}}",
			},
		},
		subtitle: "极简 AI 翻译器，支持 OpenAI / Anthropic / Gemini / Ollama。",
		translator: {
			source: {
				clear: "清空",
				description: "输入 {{language}} 内容",
				placeholder: "请输入你要翻译的内容…",
				swapLanguages: "交换语言",
				title: "原文",
				translateNow: "立即翻译",
			},
			target: {
				copyTranslation: "复制译文",
				description: "{{source}} → {{target}}",
				placeholder: "译文会出现在这里…",
				title: "译文",
			},
		},
		ui: {
			badges: {
				noProvider: "未配置 Provider",
			},
			buttons: {
				manageProvider: "设置",
				provider: "Provider",
				setupProvider: "Quick Start",
			},
			tooltips: {
				copySource: "复制原文",
				copyTranslation: "复制译文",
			},
		},
	},
	translateHistoryPage: {
		title: "翻译历史",
		subtitle: "查看全部本地翻译记录，支持分页与导出 JSON。",
		actions: {
			backHome: "返回首页",
			clear: "清空历史",
			exportJson: "导出 JSON",
			pageSize: "每页数量",
		},
		pageSize: {
			items10: "10 条/页",
			items100: "100 条/页",
		},
		card: {
			title: "全部记录",
			description: "记录保存在本地浏览器（IndexedDB）。",
			total: "{{count}} 条",
		},
		confirm: {
			title: "清空翻译历史？",
			description: "将删除本地浏览器中保存的全部翻译历史记录。",
		},
		empty: "暂无记录。",
		pagination: {
			next: "下一页",
			page: "第 {{page}} / {{pageCount}} 页",
			prev: "上一页",
			showing: "显示第 {{from}}–{{to}} 条，共 {{total}} 条",
		},
		toasts: {
			cleared: "已清空翻译历史",
			exportFailed: "导出失败",
			exported: "已导出 JSON",
		},
	},
} as const;
