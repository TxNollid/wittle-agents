"use client";
import { useEffect, useRef, useState } from "react";

export default function ButterflyGarden() {
  const scene = useRef(null);
  const [paused, setPaused] = useState(false);
  const [inView, setInView] = useState(false);
  const [pageActive, setPageActive] = useState(true);
  useEffect(() => {
    const observer = new IntersectionObserver(
      ([entry]) => setInView(entry.isIntersecting),
      { threshold: 0.05 },
    );
    observer.observe(scene.current);
    const visibility = () => setPageActive(!document.hidden);
    visibility();
    document.addEventListener("visibilitychange", visibility);
    return () => {
      observer.disconnect();
      document.removeEventListener("visibilitychange", visibility);
    };
  }, []);
  return (
    <figure
      className="hero-garden"
      ref={scene}
      data-paused={paused || !inView || !pageActive}
      aria-label="The host and auditor meet in your private Wittle Room"
    >
      <div className="garden-clearing">
        <div className="garden-plants" aria-hidden="true">
          <img
            className="garden-fern garden-fern-left"
            src="/fieldglow/fern.svg"
            width="150"
            height="210"
            alt=""
          />
          <img
            className="garden-fern garden-fern-right"
            src="/fieldglow/fern.svg"
            width="150"
            height="210"
            alt=""
          />
          <img
            className="garden-sprig"
            src="/fieldglow/sprig.svg"
            width="150"
            height="210"
            alt=""
          />
          <img
            className="garden-daisy"
            src="/fieldglow/daisy.svg"
            width="160"
            height="200"
            alt=""
          />
          <svg
            className="garden-thread"
            viewBox="0 0 100 100"
            preserveAspectRatio="none"
          >
            <path d="M30 30 C42 49 57 28 73 42" />
          </svg>
        </div>
        <div className="garden-agent garden-host">
          <img
            className="butterfly"
            src="/fieldglow/butterfly-line-cobalt.svg"
            width="104"
            height="86"
            alt=""
            aria-hidden="true"
          />
          <strong>Host</strong>
          <span>Your brief</span>
        </div>
        <div className="garden-agent garden-auditor">
          <img
            className="butterfly"
            src="/fieldglow/butterfly-dot-coral.svg"
            width="96"
            height="80"
            alt=""
            aria-hidden="true"
          />
          <strong>Auditor</strong>
          <span>A fresh perspective</span>
        </div>
      </div>
      <figcaption>
        A wittle room. <span>Your scope, first.</span>
      </figcaption>
      <button
        className="motion-control"
        type="button"
        onClick={() => setPaused((value) => !value)}
        aria-pressed={paused}
        aria-label={
          paused ? "Resume butterfly motion" : "Pause butterfly motion"
        }
        title={paused ? "Resume butterfly motion" : "Pause butterfly motion"}
      >
        <svg
          width="15"
          height="15"
          viewBox="0 0 20 20"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          aria-hidden="true"
        >
          {paused ? <path d="m7 4 8 6-8 6Z" /> : <path d="M7 4v12M13 4v12" />}
        </svg>
      </button>
    </figure>
  );
}
