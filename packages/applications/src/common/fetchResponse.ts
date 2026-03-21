export interface FetchResponseProps<T> {
    data: T[];
    count?: number;
    limit?: number;
    page?: number;
}

export class FetchResponse<T> {
    readonly data: T[];
    readonly count: number;
    readonly limit: number;
    readonly page: number;

    constructor(props: FetchResponseProps<T>) {
        this.data = props.data || [];
        this.count = props.count || 0;
        this.limit = props.limit || 0;
        this.page = props.page || 0;
    }
}
