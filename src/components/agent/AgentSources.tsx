// AI Elements "Sources" pattern (ui.shadcn.com/docs/ai-elements/base/sources), built on the
// unmodified shadcn Trace component. Citations are same-origin pages, so they open in this tab.
import type { SourceUrlUIPart } from 'ai';
import { ArrowRightIcon, BookOpenIcon } from 'lucide-react';

import {
  Trace,
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceIcon,
  TraceLine,
  TraceTitle,
} from '@/components/ui/trace';

export function AgentSources({ sources }: { sources: SourceUrlUIPart[] }) {
  if (sources.length === 0) return null;
  return (
    <Trace>
      <TraceCollapsible>
        <TraceCollapsibleTrigger className="min-h-11 min-w-11">
          <TraceLine>
            <TraceIcon>
              <BookOpenIcon />
            </TraceIcon>
            <TraceTitle>
              Used {sources.length} {sources.length === 1 ? 'source' : 'sources'}
            </TraceTitle>
          </TraceLine>
        </TraceCollapsibleTrigger>
        <TraceCollapsibleContent>
          <Trace className="gap-0">
            {sources.map((source) => (
              <a key={source.url} href={source.url} className="agent-source min-h-11 min-w-11 items-center">
                <TraceLine>
                  <TraceTitle className="whitespace-normal">{source.title ?? source.url}</TraceTitle>
                  <TraceIcon>
                    <ArrowRightIcon />
                  </TraceIcon>
                </TraceLine>
              </a>
            ))}
          </Trace>
        </TraceCollapsibleContent>
      </TraceCollapsible>
    </Trace>
  );
}
