import { useQueryClient } from "@tanstack/react-query";
import { useExecuteProposal, getListReposQueryKey, getListProposalsQueryKey, getListActionLogQueryKey } from "@workspace/api-client-react";
import type { Proposal } from "@workspace/api-client-react";
import { Zap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";

export function ProposalCard({ proposal }: { proposal: Proposal }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const execute = useExecuteProposal();

  const handleExecute = () => {
    execute.mutate({ id: proposal.id }, {
      onSuccess: (res) => {
        toast({ title: "Actie uitgevoerd", description: res.message });
        queryClient.invalidateQueries({ queryKey: getListReposQueryKey() });
        queryClient.invalidateQueries({ queryKey: getListProposalsQueryKey() });
        queryClient.invalidateQueries({ queryKey: getListActionLogQueryKey() });
      },
      onError: (err: any) => {
        toast({ 
          title: "Fout bij uitvoeren", 
          description: err?.data?.error || "Er is een onbekende fout opgetreden.",
          variant: "destructive"
        });
      }
    });
  };

  return (
    <div className="rounded-xl border border-primary/30 bg-primary/5 p-4 flex flex-col gap-3">
      <div className="flex items-start gap-3">
        <div className="mt-0.5 p-1.5 rounded-lg bg-primary/20 text-primary">
          <Zap className="h-5 w-5" />
        </div>
        <div className="flex-1">
          <h3 className="font-semibold text-primary">{proposal.title}</h3>
          <p className="text-sm text-foreground/80 mt-1 leading-relaxed">{proposal.description}</p>
        </div>
      </div>
      <div className="mt-2 bg-background/60 rounded-lg p-3 text-sm border border-primary/10">
        <p className="font-medium text-foreground mb-1.5">Actie die wordt uitgevoerd:</p>
        <p className="text-muted-foreground mb-4">{proposal.actionDescription}</p>
        <Button 
          onClick={handleExecute} 
          disabled={execute.isPending}
          className="w-full sm:w-auto font-medium"
        >
          {execute.isPending ? "Bezig met uitvoeren..." : "Nu uitvoeren"}
        </Button>
      </div>
    </div>
  );
}
