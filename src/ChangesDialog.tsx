import { GitBranchIcon, SparklesIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { describeGit, diffLineKind, gitChanges, gitCommit, type Changes, type GitInfo } from "./git";
import { draftCommitMessage } from "./gitMessage";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspace: string;
  project: string;
  info: GitInfo | undefined;
  apiKey: string;
  model: string;
  busy: boolean; // the agent is working: the files are still changing
  onCommitted: (summary: string) => void;
};

const LINE_COLOURS = {
  add: "bg-green-500/15 text-green-700 dark:text-green-300",
  del: "bg-red-500/15 text-red-700 dark:text-red-300",
  hunk: "text-blue-600 dark:text-blue-400",
  meta: "font-semibold text-muted-foreground",
  context: "",
};

const STATUS_LABEL = { modified: "modified", added: "new (staged)", deleted: "deleted", renamed: "renamed", untracked: "new", conflict: "conflict" };

/** A project's git changes: the files, the diff, and a commit. Nothing is pushed. */
export default function ChangesDialog({ open, onOpenChange, workspace, project, info, apiKey, model, busy, onCommitted }: Props) {
  const [changes, setChanges] = useState<Changes | null>(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [working, setWorking] = useState<"" | "drafting" | "committing">("");

  const load = () =>
    gitChanges(workspace, project)
      .then((c) => {
        setChanges(c);
        setError("");
      })
      .catch((e) => {
        setChanges(null);
        setError(String(e));
      });

  useEffect(() => {
    if (!open) return;
    setChanges(null);
    setMessage("");
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, project]);

  const lines = useMemo(() => (changes?.diff ? changes.diff.split("\n") : []), [changes]);
  const total = changes?.files.length ?? 0;

  async function draft() {
    if (!changes) return;
    setWorking("drafting");
    setError("");
    try {
      setMessage(await draftCommitMessage({ apiKey, model, files: changes.files.map((f) => f.path), diff: changes.diff }));
    } catch (e) {
      setError(`Couldn't draft a message: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setWorking("");
    }
  }

  async function commit() {
    setWorking("committing");
    setError("");
    try {
      const summary = await gitCommit(workspace, project, message);
      onCommitted(summary);
      onOpenChange(false);
    } catch (e) {
      setError(String(e));
      void load();
    } finally {
      setWorking("");
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-3xl overflow-hidden sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <GitBranchIcon className="size-4" /> {project}
          </DialogTitle>
          <DialogDescription>{info ? describeGit(info) : ""}. Committing stays on this computer; nothing is pushed.</DialogDescription>
        </DialogHeader>

        {busy && <p className="text-xs text-amber-600 dark:text-amber-400">The agent is still working, so these files may change.</p>}
        {error && <p className="rounded-md border border-red-500/40 bg-red-500/10 px-2 py-1 text-xs text-red-600 dark:text-red-400">{error}</p>}

        {changes === null && !error ? (
          <Spinner />
        ) : changes && total === 0 ? (
          <p className="text-sm text-muted-foreground">No changes. Everything matches the last commit.</p>
        ) : changes ? (
          <div className="flex min-h-0 flex-col gap-3">
            <ul className="max-h-28 shrink-0 overflow-y-auto text-xs">
              {changes.files.map((f) => (
                <li key={f.path} className="flex gap-2">
                  <span className="w-20 shrink-0 text-muted-foreground">{STATUS_LABEL[f.status]}</span>
                  <span className="truncate font-mono" title={f.path}>
                    {f.path}
                  </span>
                </li>
              ))}
            </ul>
            <pre className="max-h-72 min-h-16 overflow-auto rounded-md border bg-muted/30 py-1 font-mono text-xs leading-5">
              {lines.length === 0 ? (
                <span className="px-2 text-muted-foreground">New files are listed above but not shown in the diff.</span>
              ) : (
                lines.map((line, i) => (
                  <div key={i} className={cn("px-2", LINE_COLOURS[diffLineKind(line)])}>
                    {line || " "}
                  </div>
                ))
              )}
            </pre>
            <div className="flex flex-col gap-2">
              <Textarea
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                rows={3}
                placeholder="Commit message"
                aria-label="Commit message"
                disabled={working !== ""}
              />
              <div className="flex items-center justify-end gap-2">
                <Button size="sm" variant="outline" onClick={draft} disabled={working !== "" || !apiKey}>
                  {working === "drafting" ? <Spinner /> : <SparklesIcon />} Draft with {model.split("/").pop()}
                </Button>
                <Button size="sm" onClick={commit} disabled={working !== "" || !message.trim()}>
                  {working === "committing" && <Spinner />} Commit {total} {total === 1 ? "file" : "files"}
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                Commits every change shown, including new files. Your repository's commit hooks run. The diff, with secrets removed, is sent to the model to draft a message.
              </p>
            </div>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
