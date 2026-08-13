// Orchestration lightweight language context (mirrors the KiloClaw pattern).
// Self-contained i18n: locale comes from the extension via orchestration.ready,
// falling back to navigator.language then "en". Only English ships in v1;
// other locales resolve to the English dictionary.

import { createContext, createEffect, createMemo, useContext, type JSX } from "solid-js"
import { normalizeLocale, RTL_LOCALES, localeToBcp47, resolveTemplate } from "../src/context/language-utils"
import type { Locale } from "../src/context/language-utils"
import { dict as en } from "./i18n/en"

const dicts: Partial<Record<Locale, Record<string, string>>> = { en }

type LanguageCtx = {
  t: (key: string, params?: Record<string, string | number | boolean | undefined>) => string
}

const LanguageContext = createContext<LanguageCtx>()

export function OrchestrationLanguageProvider(props: { locale: () => string | undefined; children: JSX.Element }) {
  const resolved = createMemo<Locale>(() => {
    const ext = props.locale()
    if (ext) return normalizeLocale(ext)
    if (typeof navigator !== "undefined" && navigator.language) return normalizeLocale(navigator.language)
    return "en"
  })

  const dict = createMemo<Record<string, string>>(() => dicts[resolved()] ?? en)

  createEffect(() => {
    const loc = resolved()
    document.documentElement.lang = localeToBcp47(loc)
    document.documentElement.dir = RTL_LOCALES.has(loc) ? "rtl" : "ltr"
  })

  const t = (key: string, params?: Record<string, string | number | boolean | undefined>) => {
    return resolveTemplate(dict()[key] ?? key, params)
  }

  return <LanguageContext.Provider value={{ t }}>{props.children}</LanguageContext.Provider>
}

export function useOrchestrationLanguage(): LanguageCtx {
  const ctx = useContext(LanguageContext)
  if (!ctx) throw new Error("useOrchestrationLanguage must be used within OrchestrationLanguageProvider")
  return ctx
}
