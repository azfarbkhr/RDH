from django.shortcuts import render, get_object_or_404, redirect
from django.http import  HttpResponseRedirect
from .models import RedirectUrls
from .forms import RedirectUrlsForm

from django.contrib.auth.decorators import login_required
from django.contrib import messages

from ipware import get_client_ip


@login_required
def index(request):
    redirect_urls = RedirectUrls.objects.filter(user=request.user)
    return render(request, 'webapp/index.html', {'redirect_urls': redirect_urls})


@login_required
def add_redirect_url(request):
    if request.method == 'POST':
        form = RedirectUrlsForm(request.POST)
        if form.is_valid():
            redirect_url = form.save(commit=False)
            redirect_url.user = request.user
            redirect_url.save()
            return redirect('index')  
    else:
        form = RedirectUrlsForm()

    return render(request, 'webapp/url_form.html', {'form': form})

@login_required
def edit_redirect_url(request, pk):
    redirect_url = get_object_or_404(RedirectUrls, pk=pk)
    if redirect_url.user != request.user:
        messages.error(request, 'An error occurred.')
        return redirect('index')

    if request.method == 'POST':
        form = RedirectUrlsForm(request.POST, instance=redirect_url)
        if form.is_valid():
            form.save()
            return redirect('index')
    else:
        form = RedirectUrlsForm(instance=redirect_url)

    return render(request, 'webapp/url_form.html', {'form': form})

def redirect_to_target(request, short_code):
    target_url = get_object_or_404(RedirectUrls, short_code=short_code)
    # print(f"Referred URL: {request.META.get('HTTP_REFERER')}")
    
    # # Let's assume that the visitor uses an iPhone...
    # # Device type checks
    # print(f"Is Mobile: {request.user_agent.is_mobile}")  # prints True
    # print(f"Is Tablet: {request.user_agent.is_tablet}")  # prints False
    # print(f"Is Touch Capable: {request.user_agent.is_touch_capable}")  # prints True
    # print(f"Is PC: {request.user_agent.is_pc}")  # prints False
    # print(f"Is Bot: {request.user_agent.is_bot}")  # prints False

    # # Accessing user agent's browser attributes
    # print(f"Browser Object: {request.user_agent.browser}")  # prints Browser(family=u'Mobile Safari', version=(5, 1), version_string='5.1')
    # print(f"Browser Family: {request.user_agent.browser.family}")  # prints 'Mobile Safari'
    # print(f"Browser Version Tuple: {request.user_agent.browser.version}")  # prints (5, 1)
    # print(f"Browser Version String: {request.user_agent.browser.version_string}")  # prints '5.1'

    # # Operating System properties
    # print(f"Operating System Object: {request.user_agent.os}")  # prints OperatingSystem(family=u'iOS', version=(5, 1), version_string='5.1')
    # print(f"Operating System Family: {request.user_agent.os.family}")  # prints 'iOS'
    # print(f"Operating System Version Tuple: {request.user_agent.os.version}")  # prints (5, 1)
    # print(f"Operating System Version String: {request.user_agent.os.version_string}")  # prints '5.1'

    # # Device properties
    # print(f"Device Object: {request.user_agent.device}")  # prints Device(family='iPhone')
    # print(f"Device Family: {request.user_agent.device.family}")  # prints 'iPhone'
    
    client_ip, is_routable = get_client_ip(request)
    print(f"Client IP: {client_ip}")
    print(f"Is Routable: {is_routable}")

    print(f"X_FORWARDED_FOR: {request.META.get('HTTP_X_FORWARDED_FOR')}")
    print(f"IP: {request.META.get('REMOTE_ADDR')}")

    return HttpResponseRedirect(target_url.target_url)


