from .forms import NewUserForm
from django.contrib.auth import login
from django.shortcuts import render, redirect


def register_request(request):
    if request.method == "POST":
        form = NewUserForm(request.POST)
        if form.is_valid():
            user = form.save()
            login(request, user)
            return redirect("index")
        else:
            error = "Unsuccessful registration. Invalid information."
            context = {'register_form': form, 'error': error}
            return render(request, 'registration/registration.html', context)
    else:
        form = NewUserForm()
        return render (request=request, template_name="registration/registration.html", context={"register_form":form})
