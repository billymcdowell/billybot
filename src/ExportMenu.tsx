import { DownloadIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

type Props = {
  disabled: boolean;
  fullOutput: boolean;
  onFullOutputChange: (on: boolean) => void;
  onExport: (format: "md" | "json") => void;
};

/** Save the open chat as Markdown or JSON. Secrets are redacted either way. */
export default function ExportMenu({ disabled, fullOutput, onFullOutputChange, onExport }: Props) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="icon-xs" variant="outline" aria-label="Export chat" title="Export chat" disabled={disabled}>
          <DownloadIcon />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel>Export this chat</DropdownMenuLabel>
        <DropdownMenuItem onSelect={() => onExport("md")}>As Markdown (.md)</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => onExport("json")}>As JSON (.json)</DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuCheckboxItem checked={fullOutput} onCheckedChange={onFullOutputChange}>
          Include full tool output
        </DropdownMenuCheckboxItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
