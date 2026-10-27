/**
 * The immersion's layer (app/Immersion), fetched with the first network opened from Home: its zoom only comes once
 * the server has imported the network, so the layer is there by then.
 */

import React, { Suspense, lazy } from "react";
import { useImmersion } from "../../utils/immersion";
import { useNetworkOpening } from "../../utils/networkOpening";

const Immersion = lazy(() => import("./Immersion"));

export default function ImmersionLayer() {
  const opening = useNetworkOpening();
  const immersion = useImmersion();
  if (!opening && !immersion) return null;
  return (
    <Suspense fallback={null}>
      <Immersion />
    </Suspense>
  );
}
