import { useRef, type ReactNode } from "react";
import { Icon } from "@mattmattmattmatt/base/primitives/icon/Icon";
import { chevronLeft, chevronRight } from "../lib/icons";

interface PosterRowProps {
  title: string;
  count?: number;
  children: ReactNode;
}

/** A titled Netflix-style horizontal rail of poster cards with scroll arrows. */
export function PosterRow({ title, count, children }: PosterRowProps) {
  const ref = useRef<HTMLDivElement>(null);
  const scrollBy = (dir: number) => () =>
    ref.current?.scrollBy({ left: dir * ref.current.clientWidth * 0.85, behavior: "smooth" });

  return (
    <section className="prow">
      <div className="prow-head">
        <h2 className="prow-title">
          {title}
          {count != null && <span className="prow-count">{count}</span>}
        </h2>
        <div className="prow-arrows">
          <button className="prow-arrow" aria-label="Scroll left" onClick={scrollBy(-1)}>
            <Icon icon={chevronLeft} size="sm" />
          </button>
          <button className="prow-arrow" aria-label="Scroll right" onClick={scrollBy(1)}>
            <Icon icon={chevronRight} size="sm" />
          </button>
        </div>
      </div>
      <div className="prow-scroller" ref={ref}>
        {children}
      </div>
    </section>
  );
}
