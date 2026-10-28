import { CoinsIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverDescription, PopoverHeader, PopoverTitle, PopoverTrigger } from "@/components/ui/popover";
import { budgetState, formatCost, type ChatUsage } from "./cost";
import { formatTokens } from "./context";

type Props = {
  usage: ChatUsage;
  cap: number; // 0 = no limit
  onAddBudget: (dollars: number) => void;
  disabled: boolean;
};

/** How much to add when a chat runs out: $1 for small caps, otherwise half again. */
export const budgetStep = (cap: number) => (cap <= 2 ? 1 : Math.round(cap / 2));

/** What this chat has cost, in the header. Turns amber near the cap and red at it. */
export default function CostChip({ usage, cap, onAddBudget, disabled }: Props) {
  if (usage.requests === 0 && cap === 0) return null;
  const state = budgetState(usage.cost, cap);
  const tone = state === "over" ? "text-red-500" : state === "warn" ? "text-amber-500" : "";
  const lowerBound = usage.unpriced > 0 ? "+" : "";
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button size="xs" variant="outline" className={tone} title="What this chat has cost">
          <CoinsIcon />
          {formatCost(usage.cost)}
          {lowerBound}
          {cap > 0 && <span className="text-muted-foreground"> / {formatCost(cap)}</span>}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72">
        <PopoverHeader>
          <PopoverTitle>
            {formatCost(usage.cost)}
            {lowerBound} spent in this chat
          </PopoverTitle>
          <PopoverDescription>
            {usage.requests} {usage.requests === 1 ? "request" : "requests"}, {formatTokens(usage.promptTokens)} tokens in,{" "}
            {formatTokens(usage.completionTokens)} out. Includes subagents and replies you regenerated.
          </PopoverDescription>
        </PopoverHeader>
        <div className="flex flex-col gap-2 text-xs text-muted-foreground">
          {usage.estimated > 0 && <p>{usage.estimated} of these costs were worked out from the model's listed prices.</p>}
          {usage.unpriced > 0 && <p>{usage.unpriced} had no known price, so the real total is higher.</p>}
          {cap > 0 ? (
            <p>
              Budget {formatCost(cap)}. The agent stops before its next request once the chat reaches it
              {state === "over" ? ", which it has." : "."}
            </p>
          ) : (
            <p>No budget set. Set one in Limits (the sliders icon).</p>
          )}
        </div>
        {cap > 0 && (
          <Button size="sm" variant="outline" disabled={disabled} onClick={() => onAddBudget(budgetStep(cap))}>
            Add {formatCost(budgetStep(cap))} to this chat
          </Button>
        )}
      </PopoverContent>
    </Popover>
  );
}
