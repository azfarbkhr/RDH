from django.contrib import admin
from .models import RedirectUrls


@admin.register(RedirectUrls)
class RedirectUrlsAdmin(admin.ModelAdmin):
    list_display = ('user', 'target_url','short_url', 'created_at', 'modified_at')
    search_fields = ('target_url',)
    list_filter = ('user', 'created_at', 'modified_at')
    readonly_fields = ('created_at', 'modified_at')