from django.urls import path
from .views import index, redirect_to_target, add_redirect_url, edit_redirect_url

urlpatterns = [ 
    path('', index, name='index'),
    path('record/', add_redirect_url, name='record_create'),
    path('record/<int:pk>/', edit_redirect_url, name='record_edit'), 
    path('l/<str:short_code>/', redirect_to_target, name='redirect_to_target'),
]
