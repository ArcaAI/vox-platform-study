
def token_classification():
    from transformers import AutoTokenizer, AutoModelForTokenClassification, pipeline
    bert_tokenizer = AutoTokenizer.from_pretrained("blaze999/Medical-NER")
    bert_model = AutoModelForTokenClassification.from_pretrained("blaze999/Medical-NER")
    pipe_bert_base_ner = pipeline("token-classification", model=bert_model, tokenizer=bert_tokenizer)
    text = "History of uncontrolled hypertension and type 2 diabetes, reporting progressive dyspnea on exertion"
    print(pipe_bert_base_ner(text))


def text_classification():
    from transformers import AutoTokenizer, AutoModelForSequenceClassification, pipeline
    # model_name = 'DATEXIS/CORe-clinical-diagnosis-prediction'
    model_name = 'shanover/symps_disease_bert_v3_c41'
    
    tokenizer = AutoTokenizer.from_pretrained(model_name)
    model = AutoModelForSequenceClassification.from_pretrained(model_name)

    pipe_bert_base_ner = pipeline("text-classification", model=model, tokenizer=tokenizer)
    text = """'breathlessness, vomiting, sweating'"""
    print(pipe_bert_base_ner(text))
    # print(pipe_bert_base_ner(text, return_all_scores=True))

def fill_mask():
    # Use a pipeline as a high-level helper
    from transformers import pipeline, AutoTokenizer, AutoModelForSequenceClassification

    tokenizer = AutoTokenizer.from_pretrained('microsoft/BiomedNLP-BiomedBERT-base-uncased-abstract-fulltext')
    model = AutoModelForSequenceClassification.from_pretrained('microsoft/BiomedNLP-BiomedBERT-base-uncased-abstract-fulltext')
    pipe = pipeline("fill-mask", model=model, tokenizer=tokenizer)
    text = "flu-like, including fever, sore throat, rash, and swollen lymph glands is symptom of [MASK]"
    print(pipe(text))

def list_all_labels():
    from transformers import AutoModelForSequenceClassification

    model = AutoModelForSequenceClassification.from_pretrained("0208suin/disease-prediction-model")

    # Print the label ID → label name mapping
    print(model.config)

def correct():
    from transformers import pipeline

    pipe = pipeline("text2text-generation", model="vennify/t5-base-grammar-correction")
    print(pipe("grammar: I am go.")) # This sentence has bad grammar.


# correct()

text_classification()