'use client';

import { useEffect } from 'react';

export function IframeHeightReporter() {
  useEffect(() => {
    if (typeof window === 'undefined') return;

    const sendHeight = () => {
      const body = document.body;
      const html = document.documentElement;

      const height = Math.max(
        body.scrollHeight,
        body.offsetHeight,
        html.clientHeight,
        html.scrollHeight,
        html.offsetHeight
      );

      window.parent.postMessage(
        {
          type: 'luxen-set-height', // 👈 message type we’ll listen for in WP
          height,
        },
        '*' // you can replace '*' with your WP origin for more security
      );
    };

    // Initial send
    sendHeight();

    // On resize
    window.addEventListener('resize', sendHeight);

    // On content changes
    let ro: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(() => sendHeight());
      ro.observe(document.body);
    }

    // Fallback: periodic check
    const intervalId = window.setInterval(sendHeight, 800);

    return () => {
      window.removeEventListener('resize', sendHeight);
      if (ro) ro.disconnect();
      window.clearInterval(intervalId);
    };
  }, []);

  // Component doesn’t render anything
  return null;
}
