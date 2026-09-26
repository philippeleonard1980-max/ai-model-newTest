package dev.kitsune.companion;

import android.app.Activity;
import android.app.PendingIntent;

import androidx.activity.result.ActivityResult;
import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.IntentSenderRequest;
import androidx.activity.result.contract.ActivityResultContracts;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.google.android.gms.auth.api.identity.AuthorizationRequest;
import com.google.android.gms.auth.api.identity.AuthorizationResult;
import com.google.android.gms.auth.api.identity.Identity;
import com.google.android.gms.common.api.ApiException;
import com.google.android.gms.common.api.CommonStatusCodes;
import com.google.android.gms.common.api.Scope;

import java.util.ArrayList;
import java.util.List;

/**
 * Google sign-in for the Android build.
 *
 * <p>The desktop app runs a PKCE loopback flow in a browser. Android cannot:
 * Google restricted custom URI schemes for new Android OAuth clients, and the
 * device-code flow's scope allowlist leaves out {@code cloud-platform}. The
 * supported route is Play Services' Authorization API, which hands the app an
 * OAuth access token directly — no redirect, no client secret, no backend.
 *
 * <p>Tokens last about an hour and there is no refresh token. That is fine here:
 * once the user has granted the scope, {@code authorize} returns a fresh token
 * with no UI at all, so the JavaScript side just asks again when the cached one
 * nears expiry. Consent appears only when Google actually demands it.
 *
 * <p>The OAuth client is registered in Google Cloud as an <em>Android</em>
 * client, keyed to this app's package name and signing certificate, so there is
 * no client ID to type into the app and nothing secret inside it to leak.
 */
@CapacitorPlugin(name = "GoogleAuth")
public class GoogleAuthPlugin extends Plugin {

    /** Comfortably inside the hour Google issues, so a call never races expiry. */
    private static final long ASSUMED_LIFETIME_MS = 55L * 60L * 1000L;

    /**
     * Consent arrives as a PendingIntent, which Capacitor's {@code @ActivityCallback}
     * cannot launch — that annotation only registers a plain StartActivityForResult
     * contract. Registering our own IntentSender contract is the supported way in.
     */
    private ActivityResultLauncher<IntentSenderRequest> consentLauncher;

    /** Saved across the consent screen, which can outlive this plugin instance. */
    private String pendingCallId;

    @Override
    public void load() {
        consentLauncher = getBridge().registerForActivityResult(
            new ActivityResultContracts.StartIntentSenderForResult(),
            this::onConsentFinished
        );
    }

    @PluginMethod
    public void authorize(PluginCall call) {
        List<Scope> scopes = readScopes(call.getArray("scopes"));
        if (scopes.isEmpty()) {
            call.reject("No scopes requested.");
            return;
        }
        final boolean silent = Boolean.TRUE.equals(call.getBoolean("silent", false));

        AuthorizationRequest request = AuthorizationRequest.builder()
            .setRequestedScopes(scopes)
            .build();

        Identity.getAuthorizationClient(getActivity())
            .authorize(request)
            .addOnSuccessListener(result -> {
                if (!result.hasResolution()) {
                    // Already granted: a token comes back with no interaction.
                    call.resolve(describe(result));
                    return;
                }
                if (silent) {
                    // A background refresh must never put a dialog on screen.
                    JSObject pending = new JSObject();
                    pending.put("accessToken", (String) null);
                    pending.put("needsConsent", true);
                    call.resolve(pending);
                    return;
                }
                PendingIntent pendingIntent = result.getPendingIntent();
                if (pendingIntent == null) {
                    call.reject("Google asked for consent but supplied no way to show it.");
                    return;
                }
                getBridge().saveCall(call);
                pendingCallId = call.getCallbackId();
                consentLauncher.launch(
                    new IntentSenderRequest.Builder(pendingIntent.getIntentSender()).build()
                );
            })
            .addOnFailureListener(error -> call.reject(readableError(error), error));
    }

    private void onConsentFinished(ActivityResult result) {
        if (pendingCallId == null) {
            return;
        }
        PluginCall call = getBridge().getSavedCall(pendingCallId);
        pendingCallId = null;
        if (call == null) {
            return;
        }
        try {
            if (result.getResultCode() != Activity.RESULT_OK) {
                call.reject("Sign-in was cancelled.");
                return;
            }
            AuthorizationResult authorization = Identity.getAuthorizationClient(getActivity())
                .getAuthorizationResultFromIntent(result.getData());
            call.resolve(describe(authorization));
        } catch (ApiException error) {
            call.reject(readableError(error), error);
        } finally {
            getBridge().releaseCall(call);
        }
    }

    @PluginMethod
    public void signOut(PluginCall call) {
        // Drops the local grant so the next authorize() asks again.
        Identity.getAuthorizationClient(getActivity())
            .clearToken()
            .addOnSuccessListener(ignored -> call.resolve())
            .addOnFailureListener(error -> call.resolve());
    }

    private List<Scope> readScopes(JSArray raw) {
        List<Scope> scopes = new ArrayList<>();
        if (raw == null) {
            return scopes;
        }
        try {
            for (String scope : raw.toList()) {
                if (scope != null && !scope.trim().isEmpty()) {
                    scopes.add(new Scope(scope));
                }
            }
        } catch (org.json.JSONException ignored) {
            // A malformed array is reported by the empty-list check above.
        }
        return scopes;
    }

    private JSObject describe(AuthorizationResult result) {
        String token = result.getAccessToken();
        JSObject payload = new JSObject();
        payload.put("accessToken", token);
        payload.put("expiresAt", token == null ? null : (Object) (System.currentTimeMillis() + ASSUMED_LIFETIME_MS));
        String email = null;
        try {
            if (result.toGoogleSignInAccount() != null) {
                email = result.toGoogleSignInAccount().getEmail();
            }
        } catch (RuntimeException ignored) {
            // The account is a convenience; its absence is not an error.
        }
        payload.put("email", email);
        payload.put("needsConsent", false);
        return payload;
    }

    /** Turns Play Services failures into something the user can act on. */
    private String readableError(Exception error) {
        if (!(error instanceof ApiException)) {
            return error.getMessage() == null ? "Google sign-in failed." : error.getMessage();
        }
        ApiException api = (ApiException) error;
        switch (api.getStatusCode()) {
            case CommonStatusCodes.SIGN_IN_REQUIRED:
                return "No Google account is signed in on this device. Add one in Android Settings, then try again.";
            case CommonStatusCodes.NETWORK_ERROR:
                return "Could not reach Google. Check your connection and try again.";
            case CommonStatusCodes.DEVELOPER_ERROR:
                return "This build is not registered with Google. The OAuth client needs this app's package name "
                    + "and signing certificate fingerprint - see the Android setup notes in the README.";
            default:
                return api.getMessage() == null
                    ? "Google sign-in failed (code " + api.getStatusCode() + ")."
                    : api.getMessage();
        }
    }
}
