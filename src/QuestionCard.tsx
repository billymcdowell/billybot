import { MessageCircleQuestionIcon } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Item, ItemActions, ItemContent, ItemDescription, ItemFooter, ItemMedia, ItemTitle } from "@/components/ui/item";
import type { Question } from "./sessions";

export const NO_PREFERENCE = "I don't have a preference. Use your best judgment, and tell me what you chose.";

type Props = {
  question: Question;
  waiting: number; // more questions behind this one
  onAnswer: (answer: string) => void;
};

/** A question from the agent: pick one of its suggestions, or type your own answer. */
export default function QuestionCard({ question, waiting, onAnswer }: Props) {
  const [text, setText] = useState("");
  const send = () => text.trim() && onAnswer(text.trim());
  return (
    <Item variant="outline" size="sm" key={question.id}>
      <ItemMedia variant="icon">
        <MessageCircleQuestionIcon />
      </ItemMedia>
      <ItemContent>
        <ItemTitle className="whitespace-pre-wrap">{question.question}</ItemTitle>
        <ItemDescription>The agent is waiting for your answer{waiting > 0 ? ` · ${waiting} more waiting` : ""}</ItemDescription>
      </ItemContent>
      <ItemActions>
        <Button size="sm" variant="ghost" onClick={() => onAnswer(NO_PREFERENCE)} title="Let the agent choose">
          No preference
        </Button>
      </ItemActions>
      <ItemFooter className="flex-col items-stretch gap-2">
        {question.options.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {question.options.map((option) => (
              <Button key={option} size="sm" variant="outline" onClick={() => onAnswer(option)}>
                {option}
              </Button>
            ))}
          </div>
        )}
        <div className="flex gap-2">
          <Input
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && send()}
            placeholder={question.options.length > 0 ? "Or type your own answer" : "Type your answer"}
            aria-label="Your answer"
          />
          <Button size="sm" onClick={send} disabled={!text.trim()}>
            Answer
          </Button>
        </div>
      </ItemFooter>
    </Item>
  );
}
