import { describe, expect, it } from "vitest";
import { levelOf, summarizeCallQuality, type StatEntry } from "./callQuality";

const pairReport = (local: Partial<StatEntry>, remote: Partial<StatEntry>, pair: Partial<StatEntry> = {}): StatEntry[] => [
  { type: "transport", id: "T", selectedCandidatePairId: "P" },
  { type: "candidate-pair", id: "P", localCandidateId: "L", remoteCandidateId: "R", nominated: true, state: "succeeded", currentRoundTripTime: 0.04, ...pair },
  { type: "local-candidate", id: "L", protocol: "udp", candidateType: "host", ...local },
  { type: "remote-candidate", id: "R", protocol: "udp", candidateType: "srflx", ...remote },
];

describe("the connection being used", () => {
  it("is UDP through a router in the usual case", () => {
    const q = summarizeCallQuality(pairReport({}, {}), []);
    expect(q.transport).toBe("udp");
    expect(q.path).toBe("nat");
  });

  it("is TCP when that is what was selected, which is what a blocked UDP port looks like", () => {
    const q = summarizeCallQuality(pairReport({ protocol: "tcp" }, { protocol: "tcp" }), []);
    expect(q.transport).toBe("tcp");
  });

  it("is a relay when either end is one, and direct when both are on one network", () => {
    expect(summarizeCallQuality(pairReport({ candidateType: "relay" }, {}), []).path).toBe("relay");
    expect(summarizeCallQuality(pairReport({}, { candidateType: "relay" }), []).path).toBe("relay");
    expect(summarizeCallQuality(pairReport({ candidateType: "host" }, { candidateType: "host" }), []).path).toBe("direct");
  });

  it("falls back to the nominated pair when there is no transport entry, and says nothing without any", () => {
    const withoutTransport = pairReport({}, {}).filter((e) => e.type !== "transport");
    expect(summarizeCallQuality(withoutTransport, []).transport).toBe("udp");
    expect(summarizeCallQuality([{ type: "candidate-pair", nominated: false, state: "waiting" }], []).transport).toBeNull();
    expect(summarizeCallQuality(null, []).transport).toBeNull();
  });
});

describe("the round trip", () => {
  it("is what the server reports back about the audio sent, in ms", () => {
    const sent = [...pairReport({}, {}), { type: "remote-inbound-rtp", kind: "audio", roundTripTime: 0.062 }];
    expect(summarizeCallQuality(sent, []).roundTripMs).toBeCloseTo(62);
  });

  it("is the connection's own measurement when no report has come back yet", () => {
    expect(summarizeCallQuality(pairReport({}, {}), []).roundTripMs).toBeCloseTo(40);
  });

  it("is unknown with nothing to go on", () => {
    expect(summarizeCallQuality(null, []).roundTripMs).toBeNull();
    expect(summarizeCallQuality([], []).roundTripMs).toBeNull();
  });
});

describe("what is arriving from the other people", () => {
  const inbound = (extra: Partial<StatEntry>): StatEntry[] => [
    { type: "inbound-rtp", kind: "audio", jitter: 0.012, jitterBufferDelay: 3.2, jitterBufferEmittedCount: 40, packetsLost: 1, packetsReceived: 99, ...extra },
  ];

  it("works out the wait before playing, the jitter and the loss", () => {
    const q = summarizeCallQuality(null, [inbound({})]);
    expect(q.bufferMs).toBeCloseTo(80); // 3.2 s over 40 samples
    expect(q.jitterMs).toBeCloseTo(12);
    expect(q.lossPercent).toBeCloseTo(1);
  });

  it("takes the worst of several people", () => {
    const q = summarizeCallQuality(null, [inbound({}), inbound({ jitter: 0.05, jitterBufferDelay: 8, jitterBufferEmittedCount: 40, packetsLost: 10, packetsReceived: 90 })]);
    expect(q.bufferMs).toBeCloseTo(200);
    expect(q.jitterMs).toBeCloseTo(50);
    expect(q.lossPercent).toBeCloseTo(10);
  });

  it("is blank when nobody else is being heard, and ignores video and a buffer that has played nothing", () => {
    expect(summarizeCallQuality(null, []).bufferMs).toBeNull();
    expect(summarizeCallQuality(null, [[{ type: "inbound-rtp", kind: "video", jitter: 1 }]]).jitterMs).toBeNull();
    expect(summarizeCallQuality(null, [inbound({ jitterBufferEmittedCount: 0 })]).bufferMs).toBeNull();
  });

  it("does not count a negative loss count (the browser can report one for duplicates) as loss", () => {
    expect(summarizeCallQuality(null, [inbound({ packetsLost: -3, packetsReceived: 100 })]).lossPercent).toBe(0);
  });
});

describe("the delay", () => {
  it("is half the round trip plus the wait before playing", () => {
    const sent = [...pairReport({}, {}), { type: "remote-inbound-rtp", kind: "audio", roundTripTime: 0.1 }];
    const received = [[{ type: "inbound-rtp", kind: "audio", jitterBufferDelay: 2, jitterBufferEmittedCount: 20 }]];
    expect(summarizeCallQuality(sent, received).delayMs).toBeCloseTo(50 + 100);
  });

  it("is only the network half while nobody is being heard, and unknown with no round trip", () => {
    const sent = [...pairReport({}, {}), { type: "remote-inbound-rtp", kind: "audio", roundTripTime: 0.1 }];
    expect(summarizeCallQuality(sent, []).delayMs).toBeCloseTo(50);
    expect(summarizeCallQuality(null, []).delayMs).toBeNull();
  });
});

describe("the verdict", () => {
  it("is good for a short delay, little loss and a steady stream over UDP", () => {
    expect(levelOf(80, 0, 10, "udp")).toBe("good");
  });
  it("is fair for a delay past 150 ms, loss past 2%, jitter past 40 ms, or TCP", () => {
    expect(levelOf(200, 0, 10, "udp")).toBe("fair");
    expect(levelOf(80, 3, 10, "udp")).toBe("fair");
    expect(levelOf(80, 0, 60, "udp")).toBe("fair");
    expect(levelOf(80, 0, 10, "tcp")).toBe("fair");
  });
  it("is poor past 250 ms or 8% loss, and unknown without a delay", () => {
    expect(levelOf(300, 0, 10, "udp")).toBe("poor");
    expect(levelOf(80, 9, 10, "udp")).toBe("poor");
    expect(levelOf(null, 0, 0, "udp")).toBe("unknown");
  });
});
