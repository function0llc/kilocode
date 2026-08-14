import { createSignal, Show, type Component } from "solid-js"
import { Button } from "@kilocode/kilo-ui/button"
import { IconButton } from "@kilocode/kilo-ui/icon-button"
import { InlineInput } from "@kilocode/kilo-ui/inline-input"
import { TextField } from "@kilocode/kilo-ui/text-field"
import type { CanvasApi } from "./types"
import { useOrchestrationLanguage } from "./language"

interface Props {
  name: () => string
  dirty: () => boolean
  saving: () => boolean
  publishing: () => boolean
  running: () => boolean
  status: () => string | undefined
  input: () => string
  canSetEntry: () => boolean
  canPublish: () => boolean
  publishHint: () => string
  onName: (value: string) => void
  onSave: () => void
  onSetEntry: () => void
  onPublish: () => void
  onInput: (value: string) => void
  onRun: () => void
  onStop: () => void
  onBack: () => void
  api: CanvasApi
}

export const Toolbar: Component<Props> = (props) => {
  const { t } = useOrchestrationLanguage()
  const [bannerHidden, setBannerHidden] = createSignal(false)

  return (
    <>
      <div class="orch-toolbar">
        <IconButton
          size="small"
          variant="ghost"
          icon="arrow-left"
          title={t("orchestration.toolbar.back")}
          onClick={props.onBack}
        />
        <div class="orch-toolbar-name">
          <InlineInput
            class="name"
            aria-label={t("orchestration.toolbar.name")}
            value={props.name()}
            size={Math.min(Math.max(props.name().length + 2, 14), 48)}
            onInput={(event) => props.onName(event.currentTarget.value)}
          />
          <Show when={props.dirty()}>
            <span class="orch-toolbar-dirty">{t("orchestration.toolbar.unsaved")}</span>
          </Show>
        </div>

        <div class="orch-toolbar-group">
          <Button
            size="small"
            variant="secondary"
            onClick={props.onSave}
            disabled={props.saving() || !props.name().trim()}
          >
            {t("orchestration.toolbar.save")}
          </Button>
          <Button
            size="small"
            variant="secondary"
            icon="star"
            onClick={props.onSetEntry}
            disabled={!props.canSetEntry()}
          >
            {t("orchestration.toolbar.setEntry")}
          </Button>
          <Button
            size="small"
            variant="primary"
            icon="play"
            onClick={props.onPublish}
            disabled={!props.canPublish() || props.publishing()}
            title={props.canPublish() ? undefined : props.publishHint()}
          >
            {t("orchestration.toolbar.publish")}
          </Button>
        </div>

        <div class="orch-toolbar-run">
          <TextField value={props.input()} placeholder={t("orchestration.run.input")} onChange={props.onInput} />
          <Button
            size="small"
            variant="primary"
            icon="play"
            disabled={!props.canPublish() || props.running()}
            title={props.canPublish() ? undefined : props.publishHint()}
            onClick={props.onRun}
          >
            {t("orchestration.run.start")}
          </Button>
          <Button size="small" variant="secondary" disabled={!props.running()} onClick={props.onStop}>
            {t("orchestration.run.stop")}
          </Button>
          <Show when={props.status()}>{(status) => <span class="orch-run-status">{status()}</span>}</Show>
        </div>

        <div class="orch-toolbar-divider" />

        <div class="orch-toolbar-group">
          <IconButton
            size="small"
            variant="ghost"
            icon="plus"
            title={t("orchestration.toolbar.zoomIn")}
            onClick={props.api.zoomIn}
          />
          <IconButton
            size="small"
            variant="ghost"
            icon="dash"
            title={t("orchestration.toolbar.zoomOut")}
            onClick={props.api.zoomOut}
          />
          <IconButton
            size="small"
            variant="ghost"
            icon="expand"
            title={t("orchestration.toolbar.fit")}
            onClick={props.api.fit}
          />
        </div>
      </div>

      <Show when={!bannerHidden()}>
        <div class="orch-banner">
          <span>{t("orchestration.toolbar.banner")}</span>
          <IconButton size="small" variant="ghost" icon="close" onClick={() => setBannerHidden(true)} />
        </div>
      </Show>
    </>
  )
}
