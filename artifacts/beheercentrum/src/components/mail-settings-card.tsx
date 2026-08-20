import { useState } from "react";
import { sendTestMail } from "@workspace/api-client-react";
import { CheckCircle2, Loader2, Mail, Send, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * "E-mailmeldingen" — status of the Microsoft Graph mail channel plus a
 * "Proefmail" button so the operator can verify the coupling end-to-end.
 */
export function MailSettingsCard({ mailConfigured }: { mailConfigured: boolean }) {
  const [state, setState] = useState<"idle" | "sending" | "sent" | "failed">("idle");
  const [errorText, setErrorText] = useState<string | null>(null);

  const sendTest = async () => {
    setState("sending");
    setErrorText(null);
    try {
      await sendTestMail();
      setState("sent");
    } catch (err) {
      setState("failed");
      // customFetch throws the parsed error body when available.
      const message =
        err && typeof err === "object" && "error" in err && typeof (err as { error: unknown }).error === "string"
          ? (err as { error: string }).error
          : "Proefmail versturen mislukt. Controleer de mailinstellingen en probeer opnieuw.";
      setErrorText(message);
    }
  };

  return (
    <div className="rounded-xl border border-border bg-card p-5 flex flex-col gap-3">
      <div className="flex items-start gap-3">
        <div
          className={cn(
            "mt-0.5 p-2 rounded-lg",
            mailConfigured ? "bg-emerald-500/10 text-emerald-500" : "bg-amber-500/10 text-amber-500",
          )}
        >
          <Mail className="h-5 w-5" />
        </div>
        <div className="flex-1">
          <p className="font-medium text-sm">E-mailmeldingen</p>
          <div className="mt-1 flex items-center gap-1.5 text-sm">
            {mailConfigured ? (
              <>
                <CheckCircle2 className="h-4 w-4 text-emerald-500 shrink-0" />
                <span className="text-emerald-500">
                  E-mail via Microsoft Graph is geconfigureerd
                </span>
              </>
            ) : (
              <>
                <XCircle className="h-4 w-4 text-amber-500 shrink-0" />
                <span className="text-amber-500">
                  E-mail is niet geconfigureerd — meldingen gaan niet per mail
                </span>
              </>
            )}
          </div>
          <p className="text-xs text-muted-foreground mt-1">
            Elke melding (rood, herinnering, afwijking) wordt ook per e-mail
            verstuurd. Mislukte mails komen in een wachtrij en worden bij de
            volgende bewakingsronde opnieuw geprobeerd.
          </p>
        </div>
      </div>

      {!mailConfigured && (
        <p className="text-xs text-muted-foreground rounded-lg bg-muted/50 border border-border/50 p-3">
          Stel <code className="bg-muted px-1 rounded">GRAPH_TENANT_ID</code>,{" "}
          <code className="bg-muted px-1 rounded">GRAPH_CLIENT_ID</code>,{" "}
          <code className="bg-muted px-1 rounded">GRAPH_CLIENT_SECRET</code>,{" "}
          <code className="bg-muted px-1 rounded">MAIL_FROM</code> en{" "}
          <code className="bg-muted px-1 rounded">MAIL_TO</code> in via Replit
          Secrets en herstart de API-server.
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <button
          onClick={sendTest}
          disabled={state === "sending" || !mailConfigured}
          className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-sm hover:bg-muted disabled:opacity-50"
        >
          {state === "sending" ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Send className="h-4 w-4" />
          )}
          Proefmail versturen
        </button>
        {state === "sent" && (
          <span className="inline-flex items-center gap-1 text-xs text-emerald-500">
            <CheckCircle2 className="h-3.5 w-3.5" /> Proefmail verstuurd — controleer je postvak
          </span>
        )}
      </div>
      {state === "failed" && errorText && (
        <p className="text-xs text-amber-500">{errorText}</p>
      )}
    </div>
  );
}
