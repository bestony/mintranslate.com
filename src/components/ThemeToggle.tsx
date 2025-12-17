import { LaptopIcon, MoonIcon, SunIcon } from "lucide-react";
import { useTheme } from "next-themes";

import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export function ThemeToggle() {
	const { setTheme } = useTheme();

	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<Button
					type="button"
					variant="outline"
					size="icon"
					className="relative"
					aria-label="切换主题"
				>
					<SunIcon className="dark:-rotate-90 dark:scale-0 rotate-0 scale-100 transition-all" />
					<MoonIcon className="dark:rotate-0 dark:scale-100 absolute rotate-90 scale-0 transition-all" />
					<span className="sr-only">切换主题</span>
				</Button>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end">
				<DropdownMenuItem onClick={() => setTheme("light")}>
					<SunIcon className="size-4" />
					浅色
				</DropdownMenuItem>
				<DropdownMenuItem onClick={() => setTheme("dark")}>
					<MoonIcon className="size-4" />
					深色
				</DropdownMenuItem>
				<DropdownMenuItem onClick={() => setTheme("system")}>
					<LaptopIcon className="size-4" />
					跟随系统
				</DropdownMenuItem>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
