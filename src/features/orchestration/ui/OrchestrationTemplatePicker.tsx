import { useRef, useState, useSyncExternalStore } from "react";
import { Popover } from "../../../shared/ui/Popover";
import { Check, ChevronDown } from "../../../shared/ui/icons";
import {
  loadOrchestrationTemplates,
  subscribeOrchestrationTemplates,
} from "../model/orchestrationTemplates";

/**
 * Beside the composer's orchestrator pill: plan the next request from a saved
 * template. Renders nothing until a template has been saved.
 */
export function OrchestrationTemplatePicker({
  value,
  onChange,
}: {
  value?: string;
  onChange(id: string | undefined): void;
}) {
  const templates = useSyncExternalStore(
    subscribeOrchestrationTemplates,
    loadOrchestrationTemplates,
    loadOrchestrationTemplates,
  );
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  if (!templates.length) return null;
  const selected = templates.find((template) => template.id === value);
  const pick = (id: string | undefined) => {
    onChange(id);
    setOpen(false);
  };
  return (
    <>
      <button
        type="button"
        ref={anchor}
        aria-label={
          selected
            ? `Plan from template: ${selected.name}`
            : "Plan from a template"
        }
        aria-expanded={open}
        aria-haspopup="listbox"
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => setOpen(!open)}
        className={`flex h-6.5 max-w-44 shrink-0 items-center gap-1 rounded-md px-1.5 text-[11px] ${
          selected
            ? "bg-content/8 text-content/75"
            : "text-content/45 hover:bg-content/8 hover:text-content/70"
        }`}
      >
        <span className="truncate">{selected?.name ?? "Template"}</span>
        <ChevronDown className="size-3 shrink-0" />
      </button>
      {open && (
        <Popover
          anchor={anchor}
          side="top"
          align="start"
          width={240}
          maxHeight={280}
          onDismiss={() => setOpen(false)}
          data-model-picker
          role="listbox"
          aria-label="Orchestration templates"
          className="overflow-y-auto overscroll-contain p-1"
        >
          {[{ id: undefined, name: "No template" }, ...templates].map(
            (template) => {
              const on = template.id === value;
              return (
                <button
                  key={template.id ?? ""}
                  type="button"
                  role="option"
                  aria-selected={on}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => pick(template.id)}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12px] text-content hover:bg-content/5"
                >
                  <span className="min-w-0 flex-1 truncate">
                    {template.name}
                  </span>
                  {on && <Check className="size-3.5 shrink-0" strokeWidth={2} />}
                </button>
              );
            },
          )}
        </Popover>
      )}
    </>
  );
}
