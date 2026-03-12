import { HelpCircle, CheckSquare, Square } from "lucide-react";

interface QuestionOption {
  label: string;
  description: string;
}

interface Question {
  id: string;
  header: string;
  question: string;
  options: QuestionOption[];
  multiSelect: boolean;
}

interface AskQuestionInput {
  requestId?: string;
  questions: Question[];
}

interface AskQuestionRendererProps {
  input: AskQuestionInput;
  embedded?: boolean;
  hideHeader?: boolean;
  selectedAnswers?: Record<string, string>;
  onSelectOption?: (questionId: string, optionLabel: string) => void;
  submitting?: boolean;
}

export function AskQuestionRenderer(props: AskQuestionRendererProps) {
  const {
    input,
    embedded = false,
    hideHeader = false,
    selectedAnswers,
    onSelectOption,
    submitting = false,
  } = props;

  if (!input || !input.questions || input.questions.length === 0) {
    return null;
  }

  return (
    <div className={`w-full ${embedded ? "" : "mt-2"} space-y-3`}>
      {input.questions.map((question, qIndex) => (
        <div
          key={qIndex}
          className="bg-zinc-900/70 border border-zinc-700/50 rounded-lg overflow-hidden"
        >
          {!hideHeader && (
            <div className="flex items-center gap-2 px-3 py-2 border-b border-zinc-700/50 bg-zinc-800/30">
              <HelpCircle size={14} className="text-violet-400" />
              <span className="text-xs font-medium text-zinc-300">
                {question.header || "Question"}
              </span>
              {question.multiSelect && (
                <span className="text-[10px] text-zinc-500 bg-zinc-700/50 px-1.5 py-0.5 rounded ml-auto">
                  Multi-select
                </span>
              )}
            </div>
          )}
          <div className="p-3 space-y-3">
            <p className="text-sm text-zinc-200">{question.question}</p>
            {question.options && question.options.length > 0 && (
              <div className="space-y-2">
                {question.options.map((option, oIndex) => {
                  const selected = selectedAnswers?.[question.id] === option.label;
                  const Icon =
                    question.multiSelect || selected ? CheckSquare : Square;
                  const canSelect = !!onSelectOption && !submitting;
                  return (
                    <button
                      type="button"
                      key={oIndex}
                      disabled={!canSelect}
                      onClick={() => {
                        if (!canSelect) {
                          return;
                        }
                        onSelectOption(question.id, option.label);
                      }}
                      className={`w-full text-left flex items-start gap-2 px-2 py-1.5 rounded border transition-colors ${
                        selected
                          ? "bg-violet-500/12 border-violet-400/45"
                          : "bg-zinc-800/40 border-zinc-700/30"
                      } ${canSelect ? "cursor-pointer hover:bg-zinc-800/70" : "cursor-default opacity-80"}`}
                    >
                      <Icon
                        size={14}
                        className={`mt-0.5 flex-shrink-0 ${selected ? "text-violet-300" : "text-violet-400/70"}`}
                      />
                      <div className="min-w-0">
                        <div
                          className={`text-xs font-medium ${selected ? "text-violet-100" : "text-zinc-200"}`}
                        >
                          {option.label}
                        </div>
                        {option.description && (
                          <div className="text-xs text-zinc-500 mt-0.5">
                            {option.description}
                          </div>
                        )}
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
