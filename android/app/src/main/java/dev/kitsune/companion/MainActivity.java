package dev.kitsune.companion;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Local plugins are not auto-discovered the way installed ones are, so
        // the Google authorization bridge is registered explicitly. This must
        // happen before super.onCreate(), which starts the Capacitor bridge.
        registerPlugin(GoogleAuthPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
