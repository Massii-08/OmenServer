package org.omen.capture;

import org.junit.jupiter.api.Test;
import java.io.ByteArrayOutputStream;
import static org.junit.jupiter.api.Assertions.*;

class SessionWriterTest {

    @Test
    void headerHasSchemaPlayerConsent() {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        SessionWriter w = new SessionWriter(out);
        w.writeHeader("Massii_08", "1.21.4", "0.1.0", 1748540000000L, 20);
        String line = out.toString().strip();
        assertTrue(line.contains("\"schema\":1"), line);
        assertTrue(line.contains("\"player\":\"Massii_08\""), line);
        assertTrue(line.contains("\"consent\":true"), line);
    }

    @Test
    void tickRecordSerializesInputsAndLook() {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        SessionWriter w = new SessionWriter(out);
        TickRecord r = new TickRecord();
        r.t = 1234; r.yaw = -12.4; r.pitch = 3.1;
        r.forward = true; r.sprint = true;
        w.writeTick(r);
        String line = out.toString().strip();
        assertTrue(line.contains("\"type\":\"tick\""), line);
        assertTrue(line.contains("\"t\":1234"), line);
        assertTrue(line.contains("\"fwd\":1"), line);
        assertTrue(line.contains("\"yaw\":-12.4"), line);
    }

    @Test
    void playerNameIsJsonEscaped() {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        SessionWriter w = new SessionWriter(out);
        w.writeHeader("ev\"il", "1.21.4", "0.1.0", 1L, 20);
        String line = out.toString();
        assertTrue(line.contains("ev\\\"il"), line);  // guillemet échappé
    }
}
