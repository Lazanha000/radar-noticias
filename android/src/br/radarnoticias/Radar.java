package br.radarnoticias;

import android.app.Application;
import android.content.Context;
import android.os.Build;
import java.io.PrintWriter;
import java.io.StringWriter;

/** Guarda o último erro que fechou o app (o celular não mostra o log). Aparece em Alertas e ajustes > Último erro. */
public class Radar extends Application {
    @Override
    public void onCreate() {
        super.onCreate();
        final Thread.UncaughtExceptionHandler padrao = Thread.getDefaultUncaughtExceptionHandler();
        final Context c = getApplicationContext();
        Thread.setDefaultUncaughtExceptionHandler(new Thread.UncaughtExceptionHandler() {
            public void uncaughtException(Thread t, Throwable e) {
                registrar(c, "Fechou (" + t.getName() + ")", e);
                if (padrao != null) padrao.uncaughtException(t, e);
            }
        });
    }

    /** Anota um erro (fatal ou não). commit(), não apply(): o processo pode morrer logo depois. */
    static void registrar(Context c, String onde, Throwable e) {
        try {
            StringWriter sw = new StringWriter();
            e.printStackTrace(new PrintWriter(sw));
            String versao = "";
            try { versao = c.getPackageManager().getPackageInfo(c.getPackageName(), 0).versionName; } catch (Exception x) { }
            String txt = new java.text.SimpleDateFormat("dd/MM/yyyy HH:mm:ss", java.util.Locale.ROOT).format(new java.util.Date())
                + " · " + onde + "\nApp " + versao + " · Android " + Build.VERSION.RELEASE + " (API " + Build.VERSION.SDK_INT + ") · "
                + Build.MANUFACTURER + " " + Build.MODEL + "\n" + sw;
            if (txt.length() > 6000) txt = txt.substring(0, 6000);
            android.content.SharedPreferences sp = c.getSharedPreferences("radar", Context.MODE_PRIVATE);
            String antes = sp.getString("erros", "");
            String todos = txt + (antes.isEmpty() ? "" : "\n\n----------\n\n" + antes);
            if (todos.length() > 20000) todos = todos.substring(0, 20000);
            sp.edit().putString("erros", todos).commit();
        } catch (Throwable x) { /* registrar nunca pode derrubar o app */ }
    }
}
