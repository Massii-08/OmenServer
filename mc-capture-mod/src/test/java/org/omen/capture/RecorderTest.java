package org.omen.capture;

import org.junit.jupiter.api.Test;
import java.io.ByteArrayOutputStream;
import static org.junit.jupiter.api.Assertions.*;

class RecorderTest {

    @Test
    void startsOff() {
        Recorder rec = new Recorder(() -> new ByteArrayOutputStream());
        assertFalse(rec.isRecording());
    }

    @Test
    void startThenRecording() {
        Recorder rec = new Recorder(() -> new ByteArrayOutputStream());
        rec.start("Massii_08", "1.21.4", "0.1.0", 1L, 20);
        assertTrue(rec.isRecording());
    }

    @Test
    void stopReturnsToOff() {
        Recorder rec = new Recorder(() -> new ByteArrayOutputStream());
        rec.start("Massii_08", "1.21.4", "0.1.0", 1L, 20);
        rec.stop();
        assertFalse(rec.isRecording());
    }

    @Test
    void ioErrorOnStartFallsBackToOff() {
        // sink qui throw à l'écriture → start doit retomber OFF (jamais bloqué en REC)
        Recorder rec = new Recorder(() -> { throw new RuntimeException("disk full"); });
        rec.start("Massii_08", "1.21.4", "0.1.0", 1L, 20);
        assertFalse(rec.isRecording(), "une erreur d'I/O doit forcer REC-off");
    }

    @Test
    void recordTickOnlyWhenRecording() {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        Recorder rec = new Recorder(() -> out);
        TickRecord r = new TickRecord();
        rec.recordTick(r);                  // OFF → ignoré
        assertEquals(0, out.size());
        rec.start("p", "1.21.4", "0.1.0", 1L, 20);
        rec.recordTick(r);                  // ON → écrit
        assertTrue(out.size() > 0);
    }
}
