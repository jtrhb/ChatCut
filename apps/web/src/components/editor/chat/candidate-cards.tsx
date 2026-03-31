import { cn } from "@/utils/ui";
import type { Candidate, ExplorationAttachment } from "@/hooks/use-chat";

interface CandidateCardsProps {
  exploration: ExplorationAttachment;
  onSelect: (explorationId: string, candidateId: string) => void;
}

interface CandidateCardProps {
  candidate: Candidate;
  onSelect: () => void;
}

function CandidateCard({ candidate, onSelect }: CandidateCardProps) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "flex flex-col gap-2 rounded-lg border bg-background p-3 text-left",
        "transition-colors hover:border-primary hover:bg-accent",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
      )}
    >
      {candidate.previewUrl && (
        <div className="w-full overflow-hidden rounded-md aspect-video bg-muted">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={candidate.previewUrl}
            alt={candidate.label}
            className="h-full w-full object-cover"
          />
        </div>
      )}

      <div className="flex flex-col gap-1">
        <span className="text-sm font-medium text-foreground leading-tight">
          {candidate.label}
        </span>
        <p className="text-xs text-muted-foreground leading-snug line-clamp-2">
          {candidate.summary}
        </p>
      </div>

      <div className="flex items-center gap-3 pt-0.5">
        <span className="text-xs text-muted-foreground">
          <span className="font-medium text-foreground">
            {candidate.metrics.durationChange}
          </span>{" "}
          duration
        </span>
        <span className="text-xs text-muted-foreground">
          <span className="font-medium text-foreground">
            {candidate.metrics.affectedElements}
          </span>{" "}
          element{candidate.metrics.affectedElements !== 1 ? "s" : ""}
        </span>
      </div>
    </button>
  );
}

export function CandidateCards({ exploration, onSelect }: CandidateCardsProps) {
  return (
    <div className="mt-2 flex flex-col gap-2">
      <p className="text-xs text-muted-foreground font-medium">
        Select a version
      </p>
      <div className="grid grid-cols-2 gap-2">
        {exploration.candidates.map((candidate) => (
          <CandidateCard
            key={candidate.candidateId}
            candidate={candidate}
            onSelect={() => onSelect(exploration.explorationId, candidate.candidateId)}
          />
        ))}
      </div>
    </div>
  );
}
