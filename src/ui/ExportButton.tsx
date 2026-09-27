import { useState } from 'preact/hooks';
import { exportPdf, fileNameFor, shareOrDownload } from '../export';
import type { Song } from '../model';
import { loadBlob } from '../services';

// "Send as PDF" button with its progress overlay.
export function ExportButton({ title, subtitle, songs, label = '📄' }: { title: string; subtitle?: string; songs: Song[]; label?: string }) {
  const [progress, setProgress] = useState<string | null>(null);

  async function run() {
    setProgress('Préparation du PDF…');
    try {
      const pdf = await exportPdf({
        title,
        subtitle,
        songs,
        load: loadBlob,
        onProgress: (d, t) => setProgress(`Préparation du PDF… ${d}/${t}`),
      });
      setProgress(null);
      await shareOrDownload(pdf, fileNameFor(subtitle ? `${title} - ${subtitle}` : title));
    } catch (e) {
      console.error(e);
      setProgress(null);
      alert(`Impossible de créer le PDF : ${(e as Error).message}`);
    }
  }

  return (
    <>
      <button class={label === '📄' ? 'icon' : ''} title="Envoyer en PDF (avec annotations)" disabled={!songs.length} onClick={run}>
        {label}
      </button>
      {progress && (
        <div class="busy-overlay">
          <div>{progress}</div>
        </div>
      )}
    </>
  );
}
