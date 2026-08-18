/**
 * Beheer van leessleutels voor externe systemen (alleen-lezen statusadres).
 * Meerdere sleutels naast elkaar, elk met een naam; intrekken raakt de rest
 * niet. De sleutelwaarde wordt éénmalig getoond bij aanmaken.
 */
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  listLeesSleutels,
  getListLeesSleutelsQueryKey,
  createLeesSleutel,
  deleteLeesSleutel,
} from "@workspace/api-client-react";
import { KeyRound, Loader2, Plus, Trash2, Copy, Check } from "lucide-react";

export function LeesSleutelsCard() {
  const queryClient = useQueryClient();
  const [naam, setNaam] = useState("");
  const [nieuweSleutel, setNieuweSleutel] = useState<{
    naam: string;
    sleutel: string;
  } | null>(null);
  const [gekopieerd, setGekopieerd] = useState(false);
  const [fout, setFout] = useState<string | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: getListLeesSleutelsQueryKey(),
    queryFn: () => listLeesSleutels(),
  });

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: getListLeesSleutelsQueryKey() });

  const aanmaken = useMutation({
    mutationFn: () => createLeesSleutel({ naam: naam.trim() }),
    onSuccess: (res) => {
      setNieuweSleutel(res);
      setGekopieerd(false);
      setNaam("");
      setFout(null);
      void invalidate();
    },
    onError: (err: unknown) => {
      const msg =
        err && typeof err === "object" && "error" in err
          ? String((err as { error: unknown }).error)
          : "Sleutel kon niet worden aangemaakt.";
      setFout(msg);
    },
  });

  const intrekken = useMutation({
    mutationFn: (sleutelNaam: string) => deleteLeesSleutel(sleutelNaam),
    onSuccess: () => {
      setFout(null);
      void invalidate();
    },
    onError: () => setFout("Sleutel kon niet worden ingetrokken."),
  });

  const kopieer = async () => {
    if (!nieuweSleutel) return;
    try {
      await navigator.clipboard.writeText(nieuweSleutel.sleutel);
      setGekopieerd(true);
    } catch {
      /* selectie blijft mogelijk */
    }
  };

  return (
    <div className="rounded-xl border border-border bg-card p-5 space-y-4">
      <div className="flex items-center gap-3">
        <div className="p-2 rounded-lg bg-primary/10 text-primary">
          <KeyRound className="h-5 w-5" />
        </div>
        <div>
          <p className="font-medium text-sm">Leessleutels voor externe systemen</p>
          <p className="text-xs text-muted-foreground mt-0.5">
            Andere systemen kunnen de stand opvragen via{" "}
            <code className="text-[11px]">/api/extern/status</code> met de
            header <code className="text-[11px]">X-Lees-Sleutel</code>. Alleen
            lezen, maximaal 60 aanvragen per minuut per sleutel; elke aanvraag
            komt in het logboek.
          </p>
        </div>
      </div>

      {nieuweSleutel && (
        <div className="rounded-lg border border-emerald-300 bg-emerald-50 p-3 space-y-2">
          <p className="text-xs font-medium text-emerald-900">
            Sleutel “{nieuweSleutel.naam}” aangemaakt. Bewaar hem nu — hij wordt
            hierna nooit meer getoond.
          </p>
          <div className="flex items-center gap-2">
            <code className="flex-1 text-[11px] break-all bg-white border border-emerald-200 rounded px-2 py-1.5 select-all">
              {nieuweSleutel.sleutel}
            </code>
            <button
              type="button"
              onClick={() => void kopieer()}
              className="shrink-0 inline-flex items-center gap-1 rounded-md border border-emerald-300 bg-white px-2 py-1.5 text-xs font-medium text-emerald-800 hover:bg-emerald-100"
            >
              {gekopieerd ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
              {gekopieerd ? "Gekopieerd" : "Kopieer"}
            </button>
          </div>
        </div>
      )}

      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (naam.trim().length >= 2 && !aanmaken.isPending) aanmaken.mutate();
        }}
      >
        <input
          value={naam}
          onChange={(e) => setNaam(e.target.value)}
          placeholder="Naam van het systeem (bijv. Connect)"
          maxLength={64}
          className="flex-1 rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary/40"
        />
        <button
          type="submit"
          disabled={naam.trim().length < 2 || aanmaken.isPending}
          className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
        >
          {aanmaken.isPending ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Plus className="h-4 w-4" />
          )}
          Aanmaken
        </button>
      </form>

      {fout && <p className="text-xs text-red-600">{fout}</p>}

      {isLoading ? (
        <div className="flex items-center gap-2 text-muted-foreground text-xs">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Sleutels ophalen…
        </div>
      ) : (data?.sleutels.length ?? 0) === 0 ? (
        <p className="text-xs text-muted-foreground">Nog geen sleutels.</p>
      ) : (
        <ul className="divide-y divide-border rounded-lg border border-border">
          {data!.sleutels.map((s) => (
            <li key={s.naam} className="flex items-center justify-between px-3 py-2">
              <div>
                <p className="text-sm font-medium">{s.naam}</p>
                <p className="text-[11px] text-muted-foreground">
                  Aangemaakt {new Date(s.aangemaakt).toLocaleDateString("nl-NL")}
                </p>
              </div>
              <button
                type="button"
                onClick={() => {
                  if (
                    window.confirm(
                      `Sleutel “${s.naam}” intrekken? Het aangesloten systeem verliest direct toegang.`,
                    )
                  )
                    intrekken.mutate(s.naam);
                }}
                disabled={intrekken.isPending}
                className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1.5 text-xs text-red-600 hover:bg-red-50 disabled:opacity-50"
              >
                <Trash2 className="h-3.5 w-3.5" />
                Intrekken
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
