import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useMemo,
  useState,
} from "react";

interface ShowReasoningContextValue {
  /**
   * The default open/closed state for reasoning blocks. Collapsed by
   * default: Pim is an assistant, not a model playground, so the answer
   * matters more than the thinking. Any block can still be opened.
   */
  showReasoning: boolean;
  setShowReasoning: (value: boolean) => void;
}

const ShowReasoningContext = createContext<ShowReasoningContextValue>({
  showReasoning: false,
  setShowReasoning: () => {},
});

const STORAGE_KEY = "pim-show-reasoning";

function readPreference(): boolean {
  if (typeof window === "undefined") return false;
  return window.localStorage.getItem(STORAGE_KEY) === "1";
}

export function ShowReasoningProvider({ children }: { children: ReactNode }) {
  const [showReasoning, setShowReasoningState] = useState(readPreference);

  const setShowReasoning = useCallback((value: boolean) => {
    setShowReasoningState(value);
    window.localStorage.setItem(STORAGE_KEY, value ? "1" : "0");
  }, []);

  const value = useMemo(
    () => ({ showReasoning, setShowReasoning }),
    [showReasoning, setShowReasoning],
  );

  return (
    <ShowReasoningContext.Provider value={value}>
      {children}
    </ShowReasoningContext.Provider>
  );
}

export const useShowReasoning = () => useContext(ShowReasoningContext);
