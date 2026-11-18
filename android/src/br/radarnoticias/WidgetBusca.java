package br.radarnoticias;

import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.Context;
import android.widget.RemoteViews;

/** Widget "Radar: busca": barra que abre o app direto na busca. Estica na largura e na altura. */
public class WidgetBusca extends AppWidgetProvider {
    @Override
    public void onUpdate(Context c, AppWidgetManager m, int[] ids) {
        RemoteViews v = new RemoteViews(c.getPackageName(), R.layout.w_busca);
        v.setOnClickPendingIntent(R.id.raiz, WidgetPrincipais.abrirApp(c, "busca", 10));
        for (int id : ids) m.updateAppWidget(id, v);
    }
}
