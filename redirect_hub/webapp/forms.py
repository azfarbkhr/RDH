from crispy_forms.helper import FormHelper
from crispy_forms.layout import Layout, Submit
from django import forms
from .models import RedirectUrls

class PrefixedURLInput(forms.TextInput):
    template_name = 'templates/widgets/prefixed_url_input.html'  


class RedirectUrlsForm(forms.ModelForm):
    class Meta:
        model = RedirectUrls
        fields = ['target_url', 'short_code']

    # def __init__(self, *args, **kwargs):
    #     super(RedirectUrlsForm, self).__init__(*args, **kwargs)
        
    #     # change field labels 
    #     self.fields['target_url'].label = 'Link To'
    #     self.fields['short_code'].label = 'Link From'


    #     # Add Bootstrap classes to form fields
    #     self.fields['target_url'].widget.attrs['class'] = 'form-control'
    #     self.fields['short_code'].widget.attrs['class'] = 'form-control'

    #     # Set additional attributes if needed
    #     # self.fields['target_url'].widget.attrs['placeholder'] = 'Users will be redirected to this URL.'
    #     # self.fields['short_code'].widget.attrs['placeholder'] = 'You will share this URL everywhere.'

    #     # add help text 
    #     self.fields['target_url'].help_text = 'Users will be redirected to this URL.'
    #     self.fields['short_code'].help_text = 'Your shareable URL – update anytime. Keep your audience connected to your latest content, whether it\'s promotions, coupons, or more.'        

    #     self.helper = FormHelper(self)
    #     self.helper.form_method = 'post'
    #     self.helper.layout = Layout(
    #         'target_url',
    #         'short_code'
    #     )
