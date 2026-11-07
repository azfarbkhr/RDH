from django.db import models
from django.contrib.auth.models import User
from django.urls import reverse
from django.utils.html import format_html

class RedirectUrls(models.Model):
    user = models.ForeignKey(User, on_delete=models.CASCADE)
    target_url = models.URLField()
    short_code = models.CharField(max_length=20, unique=True, error_messages={'unique': "A link with this URL already exists. Please use a different URL."})
    created_at = models.DateTimeField(auto_now_add=True)
    modified_at = models.DateTimeField(auto_now=True)

    def __str__(self):
        return f"{self.target_url} - {self.short_code}"
    
    def get_short_url(self):
        return reverse('redirect_to_target', args=[self.short_code])
    
    def short_url(self):
        short_url = reverse('redirect_to_target', args=[self.short_code])
        return format_html(f'<a href="{short_url}" target="_blank">{self.short_code}</a>')    

    class Meta:
        verbose_name_plural = 'Redirect URLs'
        verbose_name = 'Redirect URL'    

