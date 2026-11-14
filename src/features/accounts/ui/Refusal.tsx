import { Banner } from '@astryxdesign/core/Banner';

/** Why a step failed, which assistive tech reads out as soon as it shows. */
export function Refusal({ title, reason }: { title: string; reason: string | undefined }) {
  return reason ? <Banner role="alert" status="error" title={title} description={reason} /> : null;
}
