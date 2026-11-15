import { ListTodo } from "lucide-react";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { CONVERSATION_SUMMARY_TOGGLE_ATTR } from "@/v4/ConversationSummaryPopover.js";
import { useConversationSummaryStore } from "@/v4/conversationSummaryStore.js";

/** Opens the conversation summary (changes, subagents, sources) under the header. */
export function WorkspaceSummaryToggleButton() {
  const { intl } = useZCodeIntl();
  const open = useConversationSummaryStore((state) => state.open);
  const toggle = useConversationSummaryStore((state) => state.toggle);
  const label = intl.formatMessage({ id: "conversationSummary.toggle" });
  return (
    <ControlHintTooltip title={label} side="bottom">
      <Button
        type="button"
        variant="ghost"
        size="icon-md"
        {...{ [CONVERSATION_SUMMARY_TOGGLE_ATTR]: "" }}
        aria-label={label}
        aria-pressed={open}
        className={cn(
          "text-foreground hover:bg-hover hover:text-foreground [app-region:no-drag]",
          open && "!bg-selected",
        )}
        onClick={toggle}
      >
        <ListTodo className="size-4" />
      </Button>
    </ControlHintTooltip>
  );
}
