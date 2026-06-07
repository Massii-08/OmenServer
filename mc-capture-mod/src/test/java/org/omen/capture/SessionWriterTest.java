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

    @Test
    void behavioralEventsSerializeWithCanonicalTypes() {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        SessionWriter w = new SessionWriter(out);
        w.writeMobAppear(100, "minecraft:zombie", 8.34);
        w.writeDamage(200, 4.0, 16);
        w.writeAttack(300, "minecraft:skeleton");
        w.writeBlockBreak(400, "minecraft:deepslate");
        String s = out.toString();
        // types alignés sur mc_capture_distill.py (reaction = mob_appear/damage ; clips = attack)
        assertTrue(s.contains("\"type\":\"mob_appear\""), s);
        assertTrue(s.contains("\"mob\":\"minecraft:zombie\""), s);
        assertTrue(s.contains("\"dist\":8.3"), s);              // arrondi 1 décimale
        assertTrue(s.contains("\"type\":\"damage\""), s);
        assertTrue(s.contains("\"hp\":16"), s);
        assertTrue(s.contains("\"type\":\"attack\""), s);
        assertTrue(s.contains("\"target\":\"minecraft:skeleton\""), s);
        assertTrue(s.contains("\"type\":\"block_break\""), s);
        assertTrue(s.contains("\"block\":\"minecraft:deepslate\""), s);
    }
}
