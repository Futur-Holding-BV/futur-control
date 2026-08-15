import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"
import { formatDistanceToNow, parseISO, format } from "date-fns"
import { nl } from "date-fns/locale"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function formatTimeAgo(dateString?: string | null) {
  if (!dateString) return 'Onbekend';
  try {
    return formatDistanceToNow(parseISO(dateString), { addSuffix: true, locale: nl });
  } catch (e) {
    return 'Onbekend';
  }
}

export function formatExactDate(dateString?: string | null) {
  if (!dateString) return 'Onbekend';
  try {
    return format(parseISO(dateString), "d MMM yyyy, HH:mm", { locale: nl });
  } catch (e) {
    return 'Onbekend';
  }
}
