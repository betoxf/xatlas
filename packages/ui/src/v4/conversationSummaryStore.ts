import { create } from "zustand";

/**
 * Whether the conversation summary popover is open. The toggle lives in the
 * workspace header, the popover inside the conversation (where its data is),
 * so they meet here.
 */
export const useConversationSummaryStore = create<{
  open: boolean;
  setOpen: (open: boolean) => void;
  toggle: () => void;
}>((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
  toggle: () => set((state) => ({ open: !state.open })),
}));
