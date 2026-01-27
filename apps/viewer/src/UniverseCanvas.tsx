import { useEffect, useRef } from "react";

import type { ChapterSummary, WorldState } from "@patchlings/engine";
import type { TelemetryEventV1 } from "@patchlings/protocol";

import type { RunStatus, SpriteStatus } from "./types";
import { ColonySimulation } from "./colony/simulation";

interface UniverseCanvasProps {
  world: WorldState | null;
  events: TelemetryEventV1[];
  chapters: ChapterSummary[];
  connected: boolean;
  status: RunStatus;
  runId: string;
  followHotspot: boolean;
  assetBase: string;
  onChapterSaved?: (runId: string) => void;
  onSpriteStatus?: (status: SpriteStatus) => void;
}

export function UniverseCanvas(props: UniverseCanvasProps): JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const simRef = useRef<ColonySimulation | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) {
      return;
    }
    const options = props.onChapterSaved || props.onSpriteStatus
      ? {
          assetBase: props.assetBase,
          followHotspot: props.followHotspot,
          ...(props.onChapterSaved ? { onChapterSaved: props.onChapterSaved } : {}),
          ...(props.onSpriteStatus ? { onSpriteStatus: props.onSpriteStatus } : {})
        }
      : {
          assetBase: props.assetBase,
          followHotspot: props.followHotspot
        };
    const sim = new ColonySimulation(host, options);
    simRef.current = sim;
    return () => {
      sim.destroy();
      simRef.current = null;
    };
    // We intentionally create the simulation once and update it via effects below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    simRef.current?.setFollowHotspot(props.followHotspot);
  }, [props.followHotspot]);

  useEffect(() => {
    simRef.current?.setConnection(props.connected, props.status, props.runId);
  }, [props.connected, props.status, props.runId]);

  useEffect(() => {
    simRef.current?.ingestWorld(props.world);
  }, [props.world]);

  useEffect(() => {
    simRef.current?.ingestChapters(props.chapters);
  }, [props.chapters]);

  useEffect(() => {
    simRef.current?.ingestEvents(props.events);
  }, [props.events]);

  useEffect(() => {
    void simRef.current?.setAssetBase(props.assetBase);
  }, [props.assetBase]);

  return <div className="universe-canvas" ref={hostRef} />;
}
