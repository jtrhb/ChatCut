import { cn } from "@/utils/ui";
import type { ChangesetAttachment } from "@/hooks/use-chat";

interface ChangesetReviewProps {
  changeset: ChangesetAttachment;
  onApprove: (changesetId: string) => void;
  onReject: (changesetId: string) => void;
}

const STATUS_BADGE: Record<
  ChangesetAttachment["status"],
  { label: string; className: string }
> = {
  pending: {
    label: "Pending",
    className: "bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400",
  },
  approved: {
    label: "Approved",
    className: "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400",
  },
  rejected: {
    label: "Rejected",
    className: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400",
  },
};

export function ChangesetReview({
  changeset,
  onApprove,
  onReject,
}: ChangesetReviewProps) {
  const decided = changeset.status !== "pending";
  const badge = STATUS_BADGE[changeset.status];

  return (
    <div className="mt-2 rounded-lg border bg-background p-3 flex flex-col gap-2.5">
      <div className="flex items-start justify-between gap-2">
        <p className="text-sm text-foreground leading-snug">{changeset.summary}</p>
        <span
          className={cn(
            "shrink-0 rounded-full px-2 py-0.5 text-xs font-medium",
            badge.className,
          )}
        >
          {badge.label}
        </span>
      </div>

      {!decided && (
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => onApprove(changeset.changesetId)}
            className={cn(
              "flex-1 rounded-md px-3 py-1.5 text-xs font-medium transition-colors",
              "bg-green-600 text-white hover:bg-green-700 active:bg-green-800",
            )}
          >
            Approve
          </button>
          <button
            type="button"
            onClick={() => onReject(changeset.changesetId)}
            className={cn(
              "flex-1 rounded-md px-3 py-1.5 text-xs font-medium transition-colors",
              "bg-red-600 text-white hover:bg-red-700 active:bg-red-800",
            )}
          >
            Reject
          </button>
        </div>
      )}
    </div>
  );
}
