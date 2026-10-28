import { CheckIcon, ClockIcon, GitForkIcon, MoreHorizontalIcon, PencilIcon, PinIcon, PinOffIcon, SearchIcon, Trash2Icon } from "lucide-react";
import { useEffect, useState } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import { formatCost } from "./cost";
import { Spinner } from "@/components/ui/spinner";
import type { SessionSummary } from "./sessions";
import type { ChatSummary, SearchHit } from "./storage";

type Props = {
  chats: ChatSummary[];
  activeId: string;
  /** What each chat is doing right now. Chats not listed are idle. */
  status: ReadonlyMap<string, SessionSummary>;
  onOpen: (id: string) => void;
  onDelete: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onPin: (id: string, pinned: boolean) => void;
  onSearch: (query: string) => Promise<SearchHit[]>;
};

/** What a chat is doing, in a glance: working, waiting its turn, waiting on you, or news since you last looked. */
function StatusMark({ summary }: { summary: SessionSummary | undefined }) {
  if (!summary) return null;
  if (summary.needsYou) {
    return <span className="size-2 shrink-0 rounded-full bg-amber-500" role="img" aria-label="Needs your approval" title="Needs your approval" />;
  }
  if (summary.phase === "running") return <Spinner className="size-3 shrink-0" aria-label="Working" />;
  if (summary.phase === "waiting") return <ClockIcon className="size-3 shrink-0 text-muted-foreground" aria-label="Waiting for a free slot" />;
  if (summary.attention === "done") return <CheckIcon className="size-3 shrink-0 text-green-600" aria-label="Finished while you were away" />;
  if (summary.attention === "failed") {
    return <span className="size-2 shrink-0 rounded-full bg-red-500" role="img" aria-label="Stopped with an error" title="Stopped with an error" />;
  }
  return null;
}

/** The sidebar's chat list: search, rename, pin and delete. */
export default function ChatList({ chats, activeId, status, onOpen, onDelete, onRename, onPin, onSearch }: Props) {
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<Map<string, string>>(new Map()); // chat id → text around the match
  const [renaming, setRenaming] = useState<string | null>(null);

  // Titles match as you type; message text is searched shortly after you stop.
  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setHits(new Map());
      return;
    }
    let current = true;
    const timer = setTimeout(() => {
      onSearch(q)
        .then((found) => current && setHits(new Map(found.map((h) => [h.id, h.snippet]))))
        .catch(() => current && setHits(new Map()));
    }, 250);
    return () => {
      current = false;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  const q = query.trim().toLowerCase();
  const shown = q ? chats.filter((c) => c.title.toLowerCase().includes(q) || hits.has(c.id)) : chats;

  function commitRename(id: string, title: string) {
    setRenaming(null);
    const current = chats.find((c) => c.id === id);
    if (title.trim() && title.trim() !== current?.title) onRename(id, title);
  }

  return (
    <SidebarGroup>
      <SidebarGroupLabel>Chats</SidebarGroupLabel>
      <SidebarGroupContent>
        {chats.length > 1 && (
          <div className="relative mb-2 px-2">
            <SearchIcon className="pointer-events-none absolute top-1/2 left-4 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === "Escape" && setQuery("")}
              placeholder="Search chats"
              aria-label="Search chats"
              className="h-8 pl-7"
            />
          </div>
        )}
        <SidebarMenu>
          {shown.length === 0 && q && <p className="px-2 py-1 text-xs text-muted-foreground">No chats match.</p>}
          {shown.map((c) => (
            <SidebarMenuItem key={c.id}>
              {renaming === c.id ? (
                <Input
                  autoFocus
                  defaultValue={c.title}
                  aria-label="Chat name"
                  className="h-8"
                  onFocus={(e) => e.currentTarget.select()}
                  onBlur={(e) => commitRename(c.id, e.currentTarget.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") e.currentTarget.blur();
                    if (e.key === "Escape") setRenaming(null);
                  }}
                />
              ) : (
                <>
                  <SidebarMenuButton
                    isActive={c.id === activeId}
                    onClick={() => onOpen(c.id)}
                    className="h-auto flex-col items-start gap-0"
                  >
                    <span className="flex w-full items-center gap-1">
                      {c.pinned && <PinIcon className="size-3 shrink-0 text-muted-foreground" aria-label="Pinned" />}
                      {c.forked && <GitForkIcon className="size-3 shrink-0 text-muted-foreground" aria-label="Forked" />}
                      <span className="min-w-0 flex-1 truncate">{c.title}</span>
                      <StatusMark summary={status.get(c.id)} />
                    </span>
                    {(() => {
                      const detail = hits.get(c.id) ?? [c.projects.join(", "), c.cost ? formatCost(c.cost) : ""].filter(Boolean).join(" · ");
                      return detail && <span className="w-full truncate text-xs text-muted-foreground">{detail}</span>;
                    })()}
                  </SidebarMenuButton>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <SidebarMenuAction showOnHover aria-label={`Actions for ${c.title}`}>
                        <MoreHorizontalIcon />
                      </SidebarMenuAction>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent side="right" align="start">
                      <DropdownMenuItem onSelect={() => setRenaming(c.id)}>
                        <PencilIcon /> Rename
                      </DropdownMenuItem>
                      <DropdownMenuItem onSelect={() => onPin(c.id, !c.pinned)}>
                        {c.pinned ? <PinOffIcon /> : <PinIcon />} {c.pinned ? "Unpin" : "Pin"}
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        variant="destructive"
                        disabled={(status.get(c.id)?.phase ?? "idle") !== "idle"}
                        onSelect={() => onDelete(c.id)}
                      >
                        <Trash2Icon /> {(status.get(c.id)?.phase ?? "idle") !== "idle" ? "Delete (stop it first)" : "Delete"}
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </>
              )}
            </SidebarMenuItem>
          ))}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  );
}
