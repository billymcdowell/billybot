import { XIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { clearAlwaysAllowed, listAlwaysAllowed, removeAlwaysAllowed } from "./storage";

type Props = { open: boolean; onOpenChange: (open: boolean) => void; workspace: string };

/** What you've told the app to always allow, per project, with a way to take each back. */
export default function PermissionsDialog({ open, onOpenChange, workspace }: Props) {
  const [rows, setRows] = useState<{ scope: string; tools: string[] }[] | null>(null);

  const refresh = () => listAlwaysAllowed().then(setRows).catch(() => setRows([]));
  useEffect(() => {
    if (open) void refresh();
  }, [open]);

  // Show a project as its name; the workspace itself (for creating projects) as "this workspace".
  const label = (scope: string) =>
    scope === workspace ? "Creating projects" : scope.startsWith(workspace) ? scope.slice(workspace.length).replace(/^[\\/]/, "") : scope;

  async function revoke(scope: string, tool: string) {
    await removeAlwaysAllowed(scope, tool);
    await refresh();
  }
  async function revokeAll() {
    for (const row of rows ?? []) await clearAlwaysAllowed(row.scope);
    await refresh();
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Always allowed</DialogTitle>
          <DialogDescription>
            Choices you made with "Always in this project". Commands are never remembered: each one asks.
          </DialogDescription>
        </DialogHeader>
        {rows === null ? null : rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nothing is always allowed. Every edit asks, unless the mode says otherwise.</p>
        ) : (
          <ul className="flex max-h-80 flex-col gap-3 overflow-y-auto">
            {rows.map((row) => (
              <li key={row.scope} className="flex flex-col gap-1">
                <span className="text-sm font-medium">{label(row.scope)}</span>
                <div className="flex flex-wrap gap-1">
                  {row.tools.map((tool) => (
                    <Button key={tool} size="xs" variant="outline" onClick={() => revoke(row.scope, tool)} title={`Stop always allowing ${tool}`}>
                      {tool} <XIcon />
                    </Button>
                  ))}
                </div>
              </li>
            ))}
          </ul>
        )}
        {rows && rows.length > 0 && (
          <Button variant="outline" size="sm" onClick={revokeAll}>
            Revoke all
          </Button>
        )}
      </DialogContent>
    </Dialog>
  );
}
