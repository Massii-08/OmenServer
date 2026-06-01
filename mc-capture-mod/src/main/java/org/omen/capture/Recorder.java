package org.omen.capture;

import java.io.OutputStream;
import java.util.function.Supplier;

/**
 * Machine d'état REC/OFF PURE (aucune dépendance Minecraft). Garantit l'invariant de
 * consentement : par défaut OFF ; toute erreur d'I/O au démarrage ou à l'écriture force OFF.
 * Le Supplier<OutputStream> est injecté (fichier en prod, mémoire en test).
 */
public class Recorder {
    private final Supplier<OutputStream> sinkFactory;
    private SessionWriter writer;
    private boolean recording = false;

    public Recorder(Supplier<OutputStream> sinkFactory) { this.sinkFactory = sinkFactory; }

    public boolean isRecording() { return recording; }

    /** Démarre une session. En cas d'erreur d'ouverture/écriture → reste OFF (consentement sûr). */
    public void start(String player, String mc, String mod, long startedAt, int sampleHz) {
        try {
            OutputStream out = sinkFactory.get();
            writer = new SessionWriter(out);
            writer.writeHeader(player, mc, mod, startedAt, sampleHz);
            recording = true;
        } catch (RuntimeException e) {
            writer = null;
            recording = false;  // ⇐ « si problème = REC-off »
        }
    }

    public void stop() { writer = null; recording = false; }

    public void recordTick(TickRecord r) {
        if (!recording || writer == null) return;
        try { writer.writeTick(r); }
        catch (RuntimeException e) { stop(); }  // erreur d'écriture → REC-off
    }

    public void recordChat(long t, String dir, String from, String text, int len) {
        if (!recording || writer == null) return;
        try { writer.writeChat(t, dir, from, text, len); }
        catch (RuntimeException e) { stop(); }
    }
}
